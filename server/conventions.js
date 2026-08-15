/**
 * conventions.js — 规范条目领域操作（任务级 + 全局两级存储）
 *
 * 晋升语义：
 *   promoteToGlobal：sources ≥ 2 个不同任务 → candidate=false（自动转正）；
 *                    否则 candidate=true（全局候选，待再次出现或人工 confirm）。
 *   promoteTaskEntry（人工提升）：直接 candidate=false。
 * 所有写入经 storage.js 原子替换；文本判重用 normalizeText（去空白标点大小写）。
 */

import { randomBytes } from 'node:crypto';
import { readTaskConventions, writeTaskConventions,
         readGlobalConventions, writeGlobalConventions } from './storage.js';

const newId = () => randomBytes(4).toString('hex');
const now = () => new Date().toISOString();

export function normalizeText(t) {
  return String(t).toLowerCase()
    .replace(/[\s，。、；：,.;:!"'“”‘’（）()【】\[\]<>《》]/g, '');
}

function findByNorm(items, text) {
  const norm = normalizeText(text);
  return items.find(e => normalizeText(e.text) === norm);
}

function touch(e) { e.hits = (e.hits ?? 0) + 1; e.updatedAt = now(); }

// ── 查询 ─────────────────────────────────────────────────────
export function listTaskConventions(taskId)  { return readTaskConventions(taskId).items; }
export function listGlobalConventions()      { return readGlobalConventions().items; }

// ── 任务级写入 ────────────────────────────────────────────────
export function addTaskEntry(taskId, { text, candidate = false, origin = 'human', sources = [] }) {
  const data = readTaskConventions(taskId);
  const exist = findByNorm(data.items, text);
  if (exist) {
    touch(exist);
    exist.sources = [...new Set([...(exist.sources ?? []), ...sources])];
    writeTaskConventions(taskId, data);
    return { entry: exist, merged: true };
  }
  const entry = { id: newId(), text, hits: 1, candidate: Boolean(candidate),
                  origin, sources: [...new Set(sources)], createdAt: now(), updatedAt: now() };
  data.items.push(entry);
  writeTaskConventions(taskId, data);
  return { entry, merged: false };
}

// ordinal：蒸馏器看到的列表序号（1-based）
export function mergeTaskEntry(taskId, ordinal, text, { candidate } = {}) {
  const data = readTaskConventions(taskId);
  const idx = ordinal - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= data.items.length) {
    return { error: `条目序号无效: ${ordinal}` };
  }
  const e = data.items[idx];
  e.text = text;
  if (candidate !== undefined) e.candidate = Boolean(candidate);
  touch(e);
  writeTaskConventions(taskId, data);
  return { entry: e };
}

export function updateTaskEntry(taskId, cid, text) {
  const data = readTaskConventions(taskId);
  const e = data.items.find(x => x.id === cid);
  if (!e) return { error: '条目不存在' };
  e.text = text; e.updatedAt = now();
  writeTaskConventions(taskId, data);
  return { entry: e };
}

export function removeTaskEntry(taskId, cid) {
  const data = readTaskConventions(taskId);
  data.items = data.items.filter(x => x.id !== cid);
  writeTaskConventions(taskId, data);
}

// ── 全局写入 ────────────────────────────────────────────────
export function addGlobalEntry({ text, origin = 'human', candidate = false, sources = [] }) {
  const data = readGlobalConventions();
  const exist = findByNorm(data.items, text);
  if (exist) {
    touch(exist);
    exist.sources = [...new Set([...(exist.sources ?? []), ...sources])];
    if (exist.sources.length >= 2) exist.candidate = false;
    writeGlobalConventions(data);
    return { entry: exist, merged: true };
  }
  const entry = { id: newId(), text, hits: 1, candidate: Boolean(candidate),
                  origin, sources: [...new Set(sources)], createdAt: now(), updatedAt: now() };
  data.items.push(entry);
  writeGlobalConventions(data);
  return { entry, merged: false };
}

export function promoteToGlobal(text, sources, origin) {
  const src = [...new Set(sources)];
  const r = addGlobalEntry({ text, origin, candidate: src.length < 2, sources: src });
  if (r.merged && r.entry.sources.length >= 2) {   // 合并后达标也要转正
    r.entry.candidate = false;
    writeGlobalConventions({ items: listGlobalConventions() });
  }
  return r;
}

export function updateGlobalEntry(cid, text) {
  const data = readGlobalConventions();
  const e = data.items.find(x => x.id === cid);
  if (!e) return { error: '条目不存在' };
  e.text = text; e.updatedAt = now();
  writeGlobalConventions(data);
  return { entry: e };
}

export function removeGlobalEntry(cid) {
  const data = readGlobalConventions();
  data.items = data.items.filter(x => x.id !== cid);
  writeGlobalConventions(data);
}

export function confirmGlobalEntry(cid) {
  const data = readGlobalConventions();
  const e = data.items.find(x => x.id === cid);
  if (!e) return { error: '条目不存在' };
  e.candidate = false; e.updatedAt = now();
  writeGlobalConventions(data);
  return { entry: e };
}

// ── 人工提升 / 降级 ──────────────────────────────────────────
export function promoteTaskEntry(taskId, cid) {
  const data = readTaskConventions(taskId);
  const e = data.items.find(x => x.id === cid);
  if (!e) return { error: '条目不存在' };
  const r = addGlobalEntry({ text: e.text, origin: e.origin, candidate: false,
                             sources: [...new Set([taskId, ...(e.sources ?? [])])] });
  data.items = data.items.filter(x => x.id !== cid);
  writeTaskConventions(taskId, data);
  return r;
}

export function demoteGlobalToTask(cid, taskId) {
  const data = readGlobalConventions();
  const e = data.items.find(x => x.id === cid);
  if (!e) return { error: '条目不存在' };
  const r = addTaskEntry(taskId, { text: e.text, candidate: false, origin: e.origin,
                                   sources: e.sources ?? [] });
  data.items = data.items.filter(x => x.id !== cid);
  writeGlobalConventions(data);
  return r;
}
