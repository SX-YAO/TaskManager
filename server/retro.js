/**
 * retro.js — 归档复盘（归档动作触发，后台执行）
 *
 * 输入归档任务的全量 pitfalls/conventions/progress，输出：
 *   ① 可复用经验 → task:convention promote → 全局候选（单任务来源 candidate=true，
 *      不直接转正；再次出现或人工 confirm 才转正）
 *   ② 复盘报告 → 归档目录 artifacts/reports/retrospective.md
 * 彻底删除不触发（router 只在 archive 端点调用）。失败静默 warn。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runToolSession } from './distiller.js';
import { record } from './metrics.js';

const BASE = process.env.TASK_MANAGER_HOME || path.join(os.homedir(), '.task-manager');
const ARCHIVE_DIR = path.join(BASE, 'archive');

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

export function readArchiveMaterials(taskId) {
  const dir = path.join(ARCHIVE_DIR, taskId);
  const pitfalls = readJsonSafe(path.join(dir, 'pitfalls.json'), { items: [] }).items ?? [];
  const conventions = readJsonSafe(path.join(dir, 'conventions.json'), { items: [] }).items ?? [];
  const progress = readJsonSafe(path.join(dir, 'progress.json'), { summary: '' });
  return { pitfalls, conventions, progress };
}

export function buildRetroPrompt(taskId) {
  return [
    '你是 TaskManager 的任务复盘器。一个任务已归档，从材料中提炼可跨任务复用的经验教训。',
    '',
    '【输出】',
    '1. 可复用经验（对其他任务也有价值的），用标签输出（每行一个，最多 5 条；没有则一条都不输出）：',
    `<task:convention action="promote" text="经验内容" sources="${taskId}" />`,
    '2. 标签之后输出一行 ===REPORT=== ，然后写复盘报告正文（Markdown）：',
    '   - 任务完成情况概要',
    '   - 关键踩坑回顾',
    '   - 做得好的 / 值得保持的',
    '   - 教训与建议',
    '',
    'text 单行，不含引号与尖括号。除标签与报告外不要输出其他内容。',
  ].join('\n');
}

export function writeRetroReport(taskId, text) {
  const body = text.split('===REPORT===')[1]?.trim();
  if (!body) return;
  const dir = path.join(ARCHIVE_DIR, taskId, 'artifacts', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'retrospective.md'), body);
}

export function runRetro(taskId) {
  const { pitfalls, conventions, progress } = readArchiveMaterials(taskId);
  const payload = {
    pitfalls: pitfalls.map(p => ({ type: p.type, description: p.description, solution: p.solution })),
    conventions: conventions.map(c => c.text),
    progress: { summary: progress.summary ?? '', completedSteps: progress.completedSteps ?? [] },
  };
  runToolSession(buildRetroPrompt(taskId), payload,
    { taskId, origin: 'retro', broadcast: () => {} })
    .then(({ counts, text, error }) => {
      if (error) {
        // 失败（spawn 失败/超时）与"真零产出"区分开：记 error 字段，zero 置 false
        console.warn('[retro]', error);
        record('distill_run', { taskId, added: 0, merged: 0, promoted: 0, zero: false, retro: true, error });
        return;
      }
      writeRetroReport(taskId, text);
      record('distill_run', { taskId, added: 0, merged: 0, promoted: counts.promote, zero: counts.promote === 0, retro: true });
    })
    .catch((e) => console.warn('[retro]', e.message));
}
