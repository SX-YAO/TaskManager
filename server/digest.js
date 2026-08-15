/**
 * digest.js — 任务纪律简报（agent 无关，所有适配器共用）
 *
 * 每轮注入 system prompt 末尾（缓存友好：变动最大的放最后）。
 * 服务端从文件实时生成——文件里有，下轮 AI 必然看到（信息回流）。
 * 自适应裁剪：无数据的行不输出，空任务只有标题 + 指针两行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readMeta, readTaskConventions, readGlobalConventions } from './storage.js';

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

// progress.pendingSteps 兼容字符串（Claude 直接 Write 的旧数据）
function normalizeSteps(steps) {
  if (Array.isArray(steps)) return steps;
  if (typeof steps === 'string') return steps.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * @param {string} taskId
 * @param {string[]} toolErrors 上轮工具调用失败清单（工具回执），置于简报顶部
 */
export function buildDigest(taskId, toolErrors = []) {
  const meta = readMeta(taskId);
  const dir = path.join(meta.projectDir, '.task-manager', taskId);
  const progress = readJsonSafe(path.join(dir, 'progress.json'), { summary: '', pendingSteps: [] });
  const pitfalls = readJsonSafe(path.join(dir, 'pitfalls.json'), { items: [] });

  const lines = ['[任务纪律简报]'];
  for (const e of toolErrors) lines.push(`⚠ 上轮工具调用失败：${e}，请重发`);

  if (progress.summary) lines.push(`进度：${String(progress.summary).slice(0, 80)}`);

  const pending = normalizeSteps(progress.pendingSteps);
  if (pending.length) lines.push(`待办：${pending.length} 项未完成`);

  const recent = (pitfalls.items ?? [])
    .map(p => String(p.description ?? '').trim())
    .filter(Boolean)   // 缺 description 的旧数据整条跳过，不渲染 undefined
    .slice(-3);
  if (recent.length) {
    lines.push('近期踩坑：');
    for (const desc of recent) lines.push(`· ${desc.slice(0, 60)}`);
  }

  const taskConv = readTaskConventions(taskId).items;
  const globalAll = readGlobalConventions().items;
  const globalActive = globalAll.filter(e => !e.candidate).length;
  const globalCand = globalAll.length - globalActive;
  if (taskConv.length + globalActive > 0) {
    lines.push(`规范：任务级 ${taskConv.length} 条 / 全局 ${globalActive} 条（含候选 ${globalCand} 条待确认）`);
  }

  lines.push('── 涉及进度更新/踩坑记录/规范查阅时，阅读 task-discipline skill ──');
  return lines.join('\n');
}
