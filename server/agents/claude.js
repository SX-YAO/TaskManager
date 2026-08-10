import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readConfig } from '../config.js';
import { parseLine, dispatch, SYSTEM_PROMPT as TOOLS_PROMPT } from '../tools/index.js';

// 使用相对路径：Claude 以 projectDir 为 cwd 启动，.task-manager/{taskId}/ 即为任务目录
const SYSTEM_PROMPT_TEMPLATE = (taskId) => [
  `你正在协助完成一个工程任务，任务文件目录（相对于当前工作目录）：.task-manager/${taskId}/`,
  '',
  '会话开始时，请依次读取以下文件了解任务背景：',
  `1. .task-manager/${taskId}/purpose.md     — 任务目的与验收标准（必读）`,
  `2. .task-manager/${taskId}/progress.json  — 当前执行进度（必读）`,
  `3. .task-manager/${taskId}/pitfalls.json  — 历史踩坑记录（必读）`,
  '',
  '在工作过程中请主动维护以下文件：',
  `- 有新进展时：通过工具更新进度（见下方工具说明）`,
  `- 遇到错误或总结经验时：通过工具记录踩坑`,
  `- 产出分析报告时：写入 .task-manager/${taskId}/artifacts/reports/<日期-主题>.md`,
  `- 产出实施方案时：写入 .task-manager/${taskId}/artifacts/plans/<日期-主题>.md`,
].join('\n');

/**
 * 读会话文件最后一条非0 assistant 的 usage，返回真实单次上下文占用。
 *
 * Claude Code 每次 API 调用后立即把该次的真实 usage（input+cache_read+cache_creation，
 * 单次非累计）写进 ~/.claude/projects/<enc>/<sid>.jsonl。最后一条 assistant 即最后一次
 * 调用 = 当前上下文快照。这比 result.usage（整轮累计计费量）准确得多。
 *
 * enc 规则：projectDir 去/ 替换为 -（开头 / 也变 -）。
 */
function readLastUsage(projectDir, sid) {
  if (!sid || !projectDir) return null;
  let pd = projectDir;
  while (pd.endsWith('/')) pd = pd.slice(0, -1);
  const enc = pd.replace(/\//g, '-');
  const file = path.join(os.homedir(), '.claude', 'projects', enc, `${sid}.jsonl`);
  let content;
  try { content = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'assistant' || !m.message?.usage) continue;
    const u = m.message.usage;
    const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (t > 0) return t;   // 末尾往前第一条非0
  }
  return null;
}

/**
 * 创建 Claude CLI Agent
 * @param {string} taskId
 * @param {string} projectDir
 * @param {string|null} sessionId          - claude CLI 的 resume sid（非任务会话 id）
 * @param {boolean} dangerouslySkipPermissions
 * @param {string|null} conflictWarning  目录冲突时注入的警告文本
 * @param {string|null} scopeConstraint  写入范围约束文本
 * @param {string|null} recentContext    重开会话时携带的最近对话
 * @param {string} taskSessionId         任务会话 id（main 或子会话 id），进 toolCtx 供 signal 等工具使用
 * @returns {import('./base.js').Agent}
 */
export function createClaudeAgent(taskId, projectDir, sessionId = null, dangerouslySkipPermissions = false, conflictWarning = null, scopeConstraint = null, recentContext = null, taskSessionId = 'main') {
  let aborted = false;
  let currentProc = null;

  return {
    /**
     * 发送一条消息，流式回调 onChunk，完成后调用 onDone
     *
     * @param {string} content
     * @param {(chunk: string) => void} onChunk          - 流式文本块回调
     * @param {(result: object) => void} onDone           - 完成回调
     * @param {(name: string, input: object) => void} onToolCall - 工具调用展示回调
     * @param {(data: object) => void} broadcast          - WebSocket 广播函数（供工具信号使用）
     */
    async sendMessage(content, onChunk, onDone, onToolCall, broadcast) {
      // broadcast 降级：调用方未传时提供空实现，避免工具内部报错
      const safeBroadcast = typeof broadcast === 'function' ? broadcast : () => {};

      // 组装 system prompt：任务背景 + 冲突警告 + 写入范围约束 + 最近对话 + 工具协议
      const parts = [SYSTEM_PROMPT_TEMPLATE(taskId)];
      if (conflictWarning)  parts.push(conflictWarning);
      if (scopeConstraint)  parts.push(scopeConstraint);   // 仅 scopeEnabled=true 时有值
      if (recentContext)    parts.push(recentContext);     // 重开会话时携带的最近对话
      parts.push(TOOLS_PROMPT);
      const systemPrompt = parts.join('\n\n');

      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--append-system-prompt', systemPrompt,
      ];
      if (dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
      if (sessionId) args.push('--resume', sessionId);

      return new Promise((resolve, reject) => {
        const cfg = readConfig();
        const cmd = cfg.agentCommand;
        const prefixArgs = Array.isArray(cfg.agentCommandArgs) ? cfg.agentCommandArgs : [];
        const proc = spawn(cmd, [...prefixArgs, ...args], {
          detached: true,  // mc 成新进程组组长（PGID = proc.pid），claude 孙进程继承同组，stop 时可一次杀整组
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
          cwd: projectDir,
        });
        currentProc = proc;
        proc.stderr.resume(); // 丢弃 stderr，防止缓冲区满导致进程死锁

        proc.stdin.write(content);
        proc.stdin.end();

        let buffer = '';
        let fullText = '';
        let newSessionId = sessionId;
        let contextTokens = null;        // 真实上下文占用（最后一次 API 调用），读会话文件取得
        let resultUsageTokens = null;    // result.usage 累计计费量，仅作兜底（文件读不到时用）
        let contextWindow = null;         // 模型上下文窗口大小（来自 modelUsage.contextWindow）
        let contextOverflow = false;      // claude 自报上下文撑爆（Prompt too long / thrashing），强制重开

        // 同一轮对话的工具信号幂等控制
        // key 格式："toolName:action"（signal）或 "toolName:toolName"（其他工具）
        const firedSignals = new Set();

        const toolCtx = { taskId, sessionId: taskSessionId, broadcast: safeBroadcast };

        proc.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留不完整的最后一行

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              handleEvent(event);
            } catch { /* 忽略非 JSON 行 */ }
          }
        });

        function handleEvent(event) {
          if (event.type === 'assistant') {
            const contents = event.message?.content ?? [];
            for (const block of contents) {
              if (block.type === 'text' && block.text) {
                processTextBlock(block.text);
              } else if (block.type === 'tool_use' && onToolCall) {
                if (!aborted) onToolCall(block.name, block.input ?? {});
              }
            }
          } else if (event.type === 'result') {
            newSessionId = event.session_id ?? newSessionId;
            // result.usage 是整轮累计计费量（非单次占用），仅作兜底，不直接当 contextTokens
            const u = event.usage;
            if (u) {
              const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
              if (t > 0) resultUsageTokens = t;
            }
            // 从 modelUsage 取真实窗口大小（前端百分比分母用）
            const mu = event.modelUsage;
            if (mu) {
              const first = Object.values(mu)[0];
              if (first?.contextWindow) contextWindow = first.contextWindow;
            }
            // 兜底：claude 自报上下文撑爆（不依赖比例阈值，切换模型也适用）
            if (event.is_error) {
              const msg = String(event.result || '');
              if (event.api_error_status === 'invalid_request' || /too long|thrashing/i.test(msg)) {
                contextOverflow = true;
              }
            }
          }
        }

        /**
         * 逐行扫描文本块：
         * - 工具调用行 → 幂等分发，从用户可见文本中剥离
         * - 普通文本行 → 推送给前端，累加到 fullText
         */
        function processTextBlock(text) {
          const textLines = text.split('\n');
          const cleanLines = [];

          for (const tl of textLines) {
            const tool = parseLine(tl);
            if (tool) {
              const key = `${tool.name}:${tool.args.action ?? tool.name}`;
              if (!firedSignals.has(key)) {
                firedSignals.add(key);
                dispatch(tool, toolCtx);
              }
            } else {
              cleanLines.push(tl);
            }
          }

          const cleanText = cleanLines.join('\n');
          if (cleanText) {
            fullText += cleanText;
            if (!aborted) onChunk(cleanText);
          }
        }

        proc.on('close', (code) => {
          if (aborted) return resolve();

          // 真实上下文占用 = 会话文件最后一条 assistant 的 usage（单次快照），
          // 优于 result.usage（累计计费量）。文件实时写（mtime==最后 assistant ts），close 时已就绪。
          const real = readLastUsage(projectDir, newSessionId);
          if (real !== null) contextTokens = real;
          else if (resultUsageTokens !== null) contextTokens = resultUsageTokens;  // 兜底

          // 降级：进程正常退出但未收到 done 信号
          if (!firedSignals.has('signal:done') && code === 0) {
            const hasOutput = fullText.trim().length > 0;
            dispatch(
              { name: 'signal', args: { action: 'done', has_output: String(hasOutput) } },
              toolCtx
            );
          }

          if (code !== 0 && !fullText) {
            return reject(new Error(`Claude 进程退出码 ${code}`));
          }
          try { onDone({ sessionId: newSessionId, fullText, contextTokens, contextWindow, contextOverflow }); } finally { resolve(); }
        });

        proc.on('error', reject);
      });
    },

    stop() {
      aborted = true;
      if (!currentProc) return;
      // detached 下 proc.pid === 进程组 PGID，负 PID 一次杀整组（mc + claude 孙）
      const pgid = currentProc.pid;
      try { process.kill(-pgid, 'SIGTERM'); } catch { /* 组已不存在 */ }
      // 2s 兜底：SIGTERM 未杀干净则 SIGKILL 强杀整组
      setTimeout(() => {
        try { process.kill(-pgid, 0); } catch { return; }  // 组已没了
        try { process.kill(-pgid, 'SIGKILL'); } catch { /* 组已不存在 */ }
      }, 2000);
    },
  };
}
