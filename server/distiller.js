/**
 * distiller.js — 规范蒸馏器（工具体系的又一个使用者，零新协议）
 *
 * 每轮 signal done 后由 index.js 触发（后台，不阻塞回复；per-task 并发去重）。
 * 蒸馏 LLM 输出 task:convention 标签 → 同一 parseLine/dispatch 写入存储。
 * 判断（add/merge/promote）由 LLM 做，服务端只机械执行。
 *
 * 失败静默 warn，永不阻塞主对话。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { readConfig } from './config.js';
import { parseLine, dispatch } from './tools/index.js';
import { listTaskConventions, listGlobalConventions } from './conventions.js';
import { listAllMeta } from './storage.js';
import { record } from './metrics.js';

const BASE = process.env.TASK_MANAGER_HOME || path.join(os.homedir(), '.task-manager');
const running = new Set();   // per-task 并发去重

// ── 通用 LLM 工具会话（retro.js 复用）────────────────────────
export function runToolSession(systemPrompt, payload, ctx, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const cfg = readConfig();
    const proc = spawn(cfg.agentCommand,
      [...(cfg.agentCommandArgs ?? []), '--print', '--append-system-prompt', systemPrompt],
      { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, cwd: BASE });   // 安全目录，不碰用户项目
    let out = '';
    proc.stdout.on('data', (c) => out += c.toString());
    proc.stderr.resume();
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ counts: { add: 0, merge: 0, promote: 0 }, text: '', error: e.message }); });
    // ENOENT 等启动失败时 stdin 流被 destroy，pending write 会抛 error 事件；挂空监听防 uncaughtException
    proc.stdin.on('error', () => {});
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    proc.on('close', () => { clearTimeout(timer); resolve(parseToolOutput(out, ctx)); });
  });
}

/** 解析 LLM 输出：工具标签行分发，其余行收集为文本（纯函数，可测） */
export function parseToolOutput(out, ctx) {
  const counts = { add: 0, merge: 0, promote: 0 };
  const textLines = [];
  for (const line of out.split('\n')) {
    const tool = parseLine(line);
    if (tool) {
      if (tool.name === 'convention' && counts[tool.args.action] !== undefined) {
        counts[tool.args.action]++;
      }
      dispatch(tool, ctx);
    } else {
      textLines.push(line);
    }
  }
  return { counts, text: textLines.join('\n').trim() };
}

// ── 蒸馏 prompt ──────────────────────────────────────────────
export function buildDistillPrompt({ taskEntries, otherCandidates, globalEntries, cap }) {
  const num = (list, prefix = '') => list.length
    ? list.map((e, i) => `${prefix}${i + 1}. ${e.text}${e.candidate ? '（候选）' : ''}`).join('\n')
    : '（无）';
  return [
    '你是 TaskManager 的规范蒸馏器。从用户消息中提炼可复用的开发规范/团队约定。',
    '',
    '【判定标准】',
    '- 只提炼"规范"：工作方式、工具偏好、协作习惯、代码约定、流程要求',
    '- 不提炼：具体 bug 修复指令、一次性操作请求、问题咨询',
    '- 引用本任务具体文件/bug/上下文的 → 任务级（candidate="false"）',
    '- 通用工作习惯（跨任务也适用）→ candidate="true"',
    '- 拿不准 → candidate="false"（宁缺毋滥）',
    '',
    '【本任务现有规范】（merge 时引用序号）',
    num(taskEntries),
    '',
    '【其他任务的候选规范】（promote 判据）',
    otherCandidates.length
      ? otherCandidates.map(c => `- [任务 ${c.taskId}] ${c.text}`).join('\n')
      : '（无）',
    '',
    '【全局现有规范】',
    num(globalEntries, 'G'),
    cap ? '注意：全局规范已超过 50 条，优先 merge 进最相近的旧条目，不要 add 新条目。' : '',
    '',
    '【输出】仅输出以下标签（每行一个），不要输出任何其他内容：',
    '<task:convention action="add" text="规范内容" candidate="true|false" />',
    '<task:convention action="merge" target="序号" text="合并后的完整文本" />',
    '<task:convention action="promote" text="规范内容" sources="taskId1,taskId2" />',
    '',
    '规则：',
    '- 没有新规范 → 一个标签都不输出',
    '- 与现有任务级条目语义重复 → merge 而不是 add',
    '- 仅当同一规范出现在 ≥2 个不同任务时 → promote（sources 列出全部来源任务 id）',
    '- text 单行，不含引号与尖括号',
    '- 最多输出 5 个标签',
  ].filter(l => l !== '').join('\n');
}

// ── 主流程 ───────────────────────────────────────────────────
function collectOtherCandidates(excludeTaskId) {
  const out = [];
  for (const meta of listAllMeta()) {
    if (meta.id === excludeTaskId || meta.archivedAt) continue;
    try {
      for (const e of listTaskConventions(meta.id)) {
        if (e.candidate) out.push({ taskId: meta.id, text: e.text });
      }
    } catch { /* 任务目录不可读则跳过 */ }
  }
  return out.slice(0, 50);
}

export function scheduleDistill(taskId, userMessage) {
  if (!userMessage?.trim()) return;
  if (running.has(taskId)) return;
  running.add(taskId);
  runDistill(taskId, userMessage)
    .catch((e) => console.warn('[distill]', e.message))
    .finally(() => running.delete(taskId));
}

async function runDistill(taskId, userMessage) {
  const taskEntries = listTaskConventions(taskId);
  const otherCandidates = collectOtherCandidates(taskId);
  const globalEntries = listGlobalConventions();
  const prompt = buildDistillPrompt({
    taskEntries, otherCandidates, globalEntries,
    cap: globalEntries.length >= 50,
  });
  const payload = {
    userMessage,
    taskEntries: taskEntries.map((e, i) => ({ n: i + 1, text: e.text, candidate: e.candidate })),
    otherCandidates,
    globalEntries: globalEntries.map((e, i) => ({ n: `G${i + 1}`, text: e.text, candidate: e.candidate })),
  };
  const { counts } = await runToolSession(prompt, payload,
    { taskId, origin: 'distill', broadcast: () => {} });
  record('distill_run', {
    taskId, added: counts.add, merged: counts.merge, promoted: counts.promote,
    zero: counts.add + counts.merge + counts.promote === 0,
  });
}
