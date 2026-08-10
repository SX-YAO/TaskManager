import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import router from './router.js';
import { getTask, listTasks, updateTaskStatus, setSessionId, listRunningTasks } from './taskManager.js';
import { appendMessage, readMessages } from './storage.js';
import { createClaudeAgent } from './agents/claude.js';

const app = express();
app.use(express.json());
app.use('/api', router);

const server = createServer(app);
const wss = new WebSocketServer({ server });

// taskId → { agent, listeners: Set<WebSocket> }  活跃会话表
const sessions = new Map();

// 上下文占窗口的比例超此阈值则跳过 --resume 开新会话。窗口大小来自 modelUsage.contextWindow。
const CONTEXT_LIMIT_RATIO = 0.8;

// 服务启动时状态修复（新状态机：idle / running / pending / reviewing / error）
// ① running → error（进程已死，无法恢复）
listRunningTasks().forEach(t => updateTaskStatus(t.id, 'error'));

// ② 旧状态迁移：paused / interrupted → reviewing
listTasks()
  .filter(t => ['paused', 'interrupted'].includes(t.status))
  .forEach(t => updateTaskStatus(t.id, 'reviewing'));

// ③ idle + 有消息历史 → reviewing（曾运行过但不知道上次结果）
//    注：有 claudeSessionId ≠ 有产出，不能据此判断为 reviewing。
//    只有当上次运行的 task:signal 明确发送了 has_output=true 时才应为 reviewing。
//    历史任务无信号记录，保守起见只看消息历史是否存在（说明确实运行过），
//    但 has_output 未知，仍维持 idle。需要用户手动打开任务才能触发新一轮工作。
//    → 暂不做自动转换，让旧任务保持 idle，避免误导用户以为有产出待验收。

wss.on('connection', (ws, req) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const taskId = searchParams.get('taskId');
  if (!taskId) { ws.close(1008, 'taskId 必填'); return; }

  try { getTask(taskId); } catch {
    ws.close(1008, '任务不存在'); return;
  }

  if (!sessions.has(taskId)) {
    sessions.set(taskId, { agent: null, listeners: new Set(), processing: false, partialText: '', roundToolCalls: [] });
  }
  const session = sessions.get(taskId);
  session.listeners.add(ws);
  ws.send(JSON.stringify({ type: 'connected', taskId }));

  // 重连补发：把本轮已积累的工具调用和流式文本发给新连接的客户端
  if (session.processing) {
    if (session.roundToolCalls.length) {
      session.roundToolCalls.forEach(tc =>
        ws.send(JSON.stringify({ type: 'tool_call', name: tc.name, input: tc.input }))
      );
    }
    if (session.partialText) {
      ws.send(JSON.stringify({ type: 'chunk', text: session.partialText }));
    }
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const session = sessions.get(taskId);

    // ── 停止当前 agent ───────────────────────────────────────
    if (msg.type === 'stop') {
      if (session.processing && session.agent) {
        session.agent.stop();
        // 保存已输出的部分内容（标记为被中断）
        if (session.partialText) {
          appendMessage(taskId, {
            role: 'assistant',
            content: session.partialText,
            timestamp: new Date().toISOString(),
            toolCalls: [],
            interrupted: true,
          });
        }
        // 停止后统一 reviewing（任务已运行过，不回到 idle）
        session.partialText = '';
        session.processing = false;
        updateTaskStatus(taskId, 'reviewing');
        broadcast(taskId, { type: 'status_change', status: 'reviewing' });
      }
      return;
    }

    if (msg.type !== 'message' || !msg.content) return;

    const { content } = msg;

    if (session.processing) {
      ws.send(JSON.stringify({ type: 'error', message: '上一条消息正在处理中，请稍等' }));
      return;
    }
    session.processing = true;
    session.partialText = '';
    session.roundToolCalls = [];   // 每轮开始清空

    // 记录用户消息
    const userMsg = { role: 'user', content, timestamp: new Date().toISOString(), toolCalls: [] };
    appendMessage(taskId, userMsg);
    broadcast(taskId, { type: 'user_message', message: userMsg });

    // 更新状态为 running
    updateTaskStatus(taskId, 'running');

    // 每次消息创建新 agent 实例（持有最新 sessionId）
    const currentMeta = getTask(taskId);
    const conflictWarning = buildConflictWarning(taskId, currentMeta.projectDir);
    const scopeConstraint = buildScopeConstraint(currentMeta);

    // 上下文超阈值：跳过 --resume 开新会话，避免继续 resume 一个撑爆/损坏的 session。
    // 新会话第一轮会按 system prompt 读取 purpose/progress/pitfalls 恢复上下文。
    let resumeSid = currentMeta.claudeSessionId;
    let recentContext = null;
    // [阈值自动重开 - 已禁用] 阈值判断暂不准确（result.usage 累计/真实占用口径仍需迭代），
    // 暂停自动重开。手动重开入口：前端「重开会话」按钮 → POST /tasks/:id/reset-context。
    // 原逻辑（保留注释供参考，恢复时取消注释即可）：
    // const ctxLimit = Math.round((currentMeta.contextWindow || 1_000_000) * CONTEXT_LIMIT_RATIO);
    // if (resumeSid && (currentMeta.contextTokens ?? 0) >= ctxLimit) {
    //   recentContext = buildRecentContext(taskId);
    //   resumeSid = null;
    //   setSessionId(taskId, null, null, currentMeta.contextWindow);
    //   broadcast(taskId, { type: 'context_reset', tokens: currentMeta.contextTokens, limit: ctxLimit, message: `上下文已达 ${Math.round(currentMeta.contextTokens / 10000)}万 token（阈值 ${Math.round(ctxLimit / 10000)}万），本轮已重开会话，将读取任务文件恢复上下文` });
    // }
    // sid 为空（手动重开后 / 首次任务）时构造最近对话衔接新会话
    if (!resumeSid) recentContext = buildRecentContext(taskId);

    const agent = createClaudeAgent(
      taskId,
      currentMeta.projectDir,
      resumeSid,
      currentMeta.dangerouslySkipPermissions,
      conflictWarning,
      scopeConstraint,
      recentContext,
    );
    session.agent = agent;

    try {
      await agent.sendMessage(
        content,
        // onChunk：流式文本推前端
        (chunk) => {
          session.partialText += chunk;
          broadcast(taskId, { type: 'chunk', text: chunk });
        },
        // onDone：保存消息（含本轮所有工具调用），广播完成
        ({ sessionId: newSid, fullText, contextTokens, contextWindow, contextOverflow }) => {
          // claude 自报上下文撑爆：弃用本轮 sid，下轮开新会话
          if (contextOverflow) {
            setSessionId(taskId, null, null, contextWindow);
            broadcast(taskId, {
              type: 'context_reset',
              tokens: null,
              limit: Math.round((contextWindow || 1_000_000) * CONTEXT_LIMIT_RATIO),
              message: `上下文已撑爆（Claude 报 Prompt too long / thrashing），已自动重开会话，将读取任务文件恢复上下文`,
            });
          } else {
            setSessionId(taskId, newSid, contextTokens, contextWindow);
          }
          appendMessage(taskId, {
            role: 'assistant',
            content: fullText,
            timestamp: new Date().toISOString(),
            toolCalls: [...session.roundToolCalls],  // 落盘，不再丢失
          });
          session.roundToolCalls = [];  // 重置，等下一轮
          broadcast(taskId, { type: 'done', sessionId: newSid });
        },
        // onToolCall：积累本轮工具调用 + 广播给前端
        (name, input) => {
          session.roundToolCalls.push({ name, input });
          broadcast(taskId, { type: 'tool_call', name, input });
        },
        // broadcast：传给工具系统，用于信号触发后的状态广播
        (data) => broadcast(taskId, data),
      );
    } catch (err) {
      // 进程崩溃（非零退出码）→ error 状态
      updateTaskStatus(taskId, 'error');
      broadcast(taskId, { type: 'error', message: err.message });
    } finally {
      session.processing = false;
    }
  });

  ws.on('close', () => {
    const session = sessions.get(taskId);
    if (session) {
      session.listeners.delete(ws);
      if (session.listeners.size === 0 && !session.processing) {
        sessions.delete(taskId);
      }
    }
  });
});

// 重开会话时携带的最近对话上下文：取 messages 最后3条，每条 content 截断 400 字
function buildRecentContext(taskId) {
  let msgs;
  try { msgs = readMessages(taskId); } catch { return null; }
  const recent = msgs.slice(-3).filter(m => m.content);
  if (!recent.length) return null;
  const lines = recent.map(m => {
    const role = m.role === 'user' ? '用户' : 'Claude';
    return `【${role}】${String(m.content).slice(0, 400)}`;
  });
  return [
    `[最近消息 · 重开会话衔接用]`,
    `本次为重开会话，以下是重开前的最后 ${recent.length} 条消息的精简摘录（每条已截断至 400 字）：`,
    '',
    ...lines,
    '',
    `完整对话历史存储于 .task-manager/${taskId}/messages.jsonl（JSONL 格式，每行一条消息，含 role/content/timestamp/toolCalls）。`,
    `若你需要更多上下文或完整内容，可读取该文件——建议从末尾按需读取若干行（如 tail），避免全量加载占用上下文。`,
  ].join('\n');
}

// 模式 B（scopeEnabled=true）时，生成写入约束提示词注入 system prompt
function buildScopeConstraint(meta) {
  if (!meta.scopeEnabled || !meta.watchedRepos?.length) return null;

  const repoPaths = meta.watchedRepos.map(r => `- ${r}`).join('\n');
  return [
    '[文件改动范围约束]',
    '',
    `本次任务的**文件写入范围**已限定为以下目录：\n${repoPaths}`,
    '',
    '**允许（不受限制）**：',
    '- 读取（Read）任意目录的文件，用于了解代码上下文、分析依赖关系等',
    '',
    '**禁止**：',
    '- 在上述范围之外的路径创建、修改或删除文件',
    '- 通过 Bash 命令在范围外写入文件（包括重定向写入 >、mv 移入范围外、rm 删除范围外文件等）',
    '',
    '如果分析后认为需要改动范围外的文件，请先告知用户说明原因，等待确认后再操作。',
  ].join('\n');
}

// 判断两个路径是否相同或互为父子
function isConflict(a, b) {
  const na = a.replace(/\/+$/, '');
  const nb = b.replace(/\/+$/, '');
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

// 构造冲突警告文本，注入 system prompt
function buildConflictWarning(currentTaskId, projectDir) {
  const conflicts = listRunningTasks().filter(
    t => t.id !== currentTaskId && isConflict(t.projectDir, projectDir),
  );
  if (!conflicts.length) return null;

  const lines = [
    '[⚠️ 目录冲突提醒 - 必读]',
    '以下任务正在操作相同或相关的项目目录：',
    ...conflicts.map(t => `  · "${t.title}"（running）- ${t.projectDir}`),
    '',
    '你必须在开始任何实质性代码改动之前：',
    '1. 主动告知用户检测到潜在的目录冲突',
    '2. 询问本次任务计划改动的文件范围',
    '3. 确认与其他任务不会冲突，或与用户商议使用隔离工作区',
    '在用户明确确认前，不要执行任何文件写入操作。',
  ];
  return lines.join('\n');
}

function broadcast(taskId, data) {
  const str = JSON.stringify(data);
  sessions.get(taskId)?.listeners.forEach(ws => {
    if (ws.readyState === 1) ws.send(str);
  });
}

const PORT = process.env.PORT || 7878;
server.listen(PORT, () => {
  console.log(`Task Manager server running on http://localhost:${PORT}`);
});
