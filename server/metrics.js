/**
 * metrics.js — 埋点事件（append-only JSONL + 5MB 轮转 + 近 7 天聚合）
 *
 * 失败静默 warn，永不阻塞主流程。审查对象：工具命中准确度、蒸馏精准度、digest 体积。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.env.TASK_MANAGER_HOME || path.join(os.homedir(), '.task-manager');
const DIR  = path.join(BASE, 'metrics');
const FILE = path.join(DIR, 'events.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;

export function record(type, data = {}) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > MAX_BYTES) {
      fs.renameSync(FILE, path.join(DIR, 'events.1.jsonl'));   // 只保留一份备份
    }
    fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n');
  } catch (e) { console.warn('[metrics] 写入失败:', e.message); }
}

function readEvents() {
  const out = [];
  for (const f of [path.join(DIR, 'events.1.jsonl'), FILE]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }
  return out;
}

export function summary() {
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  const events = readEvents().filter(e => new Date(e.ts).getTime() >= since);

  const toolCall = { total: 0, okRate: 1, byTool: {} };
  const distill  = { runs: 0, produced: 0, promoted: 0, zero: 0 };
  const edits    = { total: 0, updateDelete: 0 };
  const digest   = { count: 0, avgBytes: 0 };
  let digestBytes = 0;

  for (const e of events) {
    if (e.type === 'tool_call') {
      toolCall.total++;
      const b = (toolCall.byTool[e.tool] ??= { total: 0, ok: 0 });
      b.total++; if (e.ok) b.ok++;
    } else if (e.type === 'distill_run') {
      distill.runs++;
      distill.produced += (e.added ?? 0) + (e.merged ?? 0);
      distill.promoted += e.promoted ?? 0;
      if (e.zero) distill.zero++;
    } else if (e.type === 'convention_edit') {
      edits.total++;
      if (e.op === 'update' || e.op === 'delete') edits.updateDelete++;
    } else if (e.type === 'digest_inject') {
      digest.count++; digestBytes += e.bytes ?? 0;
    }
  }

  const okCount = Object.values(toolCall.byTool).reduce((s, b) => s + b.ok, 0);
  if (toolCall.total) toolCall.okRate = okCount / toolCall.total;
  if (digest.count) digest.avgBytes = Math.round(digestBytes / digest.count);

  return {
    toolCall, distill,
    conventionEdit: edits,
    editRate: edits.updateDelete / Math.max(distill.produced, 1),   // 人工编辑率：蒸馏精准度反向指标
    digest,
  };
}
