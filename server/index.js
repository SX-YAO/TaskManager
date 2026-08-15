import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import router from './router.js';
import { getTask, listTasks, listSessions, getSession,
         updateSessionStatus, setSessionSid, listRunningSessions,
         migrateLegacyTask, aggregateStatus } from './taskManager.js';
import { appendSessionMessage, readSessionMessages } from './storage.js';
import { createClaudeAgent } from './agents/claude.js';
import { sessionRuntimes, getRuntime, broadcastTo, broadcastTask, stopRuntime } from './runtime.js';

const app = express();
app.use(express.json());
app.use('/api', router);

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ── 服务启动：旧格式迁移 + 状态修复 ────────────────────────────
// ① 旧格式任务（无 sessions 字段）→ 合成 main 会话 + 迁移消息
listTasks().forEach(t => {
  try { migrateLegacyTask(t.id); } catch (e) {
    console.warn(`[migrate] 任务 ${t.id} 迁移失败（跳过）: ${e.message}`);
  }
});
// ② running 会话 → error（进程已死，无法恢复）
listRunningSessions().forEach(r => updateSessionStatus(r.taskId, r.sessionId, 'error'));
// ③ 旧状态迁移：paused / interrupted → reviewing（按会话）
listTasks().forEach(t => {
  (t.sessions ?? [])
    .filter(s => ['paused', 'interrupted'].includes(s.status))
    .forEach(s => updateSessionStatus(t.id, s.id, 'reviewing'));
});

wss.on('connection', (ws, req) => {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const taskId = searchParams.get('taskId');
  const type = searchParams.get('type');
  let sessionId = searchParams.get('sessionId');

  // ── 连接校验（显式类型，无静默兜底）────────────────────────
  if (!taskId) { ws.close(1008, 'taskId 必填'); return; }
  let meta;
  try { meta = getTask(taskId); } catch {
    ws.close(1008, '任务不存在'); return;
  }
  if (!['main', 'sub'].includes(type)) {
    ws.close(1008, 'type 必填（main|sub）'); return;
  }
  if (type === 'main') sessionId = 'main';
  if (!sessionId) { ws.close(1008, 'type=sub 时 sessionId 必填'); return; }
  let session;
  try { session = getSession(taskId, sessionId); } catch {
    ws.close(1008, '会话不存在'); return;
  }

  const rt = getRuntime(taskId, sessionId);
  rt.listeners.add(ws);
  ws.send(JSON.stringify({ type: 'connected', taskId, sessionId, status: session.status }));

  // 重连补发
  if (rt.processing) {
    rt.roundToolCalls.forEach(tc =>
      ws.send(JSON.stringify({ type: 'tool_call', name: tc.name, input: tc.input })));
    if (rt.partialText) {
      ws.send(JSON.stringify({ type: 'chunk', text: rt.partialText }));
    }
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── 停止当前 agent ──
    if (msg.type === 'stop') {
      if (rt.processing && rt.agent) {
        rt.agent.stop();
        if (rt.partialText) {
          appendSessionMessage(taskId, sessionId, {
            role: 'assistant', content: rt.partialText,
            timestamp: new Date().toISOString(), toolCalls: [], interrupted: true,
          });
        }
        rt.partialText = '';
        rt.processing = false;
        updateSessionStatus(taskId, sessionId, 'reviewing');
        broadcastTo(taskId, sessionId, { type: 'session_status_change', sessionId, status: 'reviewing' });
        broadcastTask(taskId, { type: 'status_change', status: aggregateStatus(getTask(taskId)) });
      }
      return;
    }

    if (msg.type !== 'message' || !msg.content) return;

    // 已关闭会话拒绝发消息
    const currentSession = getSession(taskId, sessionId);
    if (currentSession.status === 'closed') {
      ws.send(JSON.stringify({ type: 'error', message: '会话已关闭，仅供回看' }));
      return;
    }

    if (rt.processing) {
      ws.send(JSON.stringify({ type: 'error', message: '上一条消息正在处理中，请稍等' }));
      return;
    }
    rt.processing = true;
    rt.partialText = '';
    rt.roundToolCalls = [];

    const userMsg = { role: 'user', content: msg.content, timestamp: new Date().toISOString(), toolCalls: [] };
    appendSessionMessage(taskId, sessionId, userMsg);
    broadcastTo(taskId, sessionId, { type: 'user_message', message: userMsg });

    updateSessionStatus(taskId, sessionId, 'running');
    broadcastTask(taskId, { type: 'status_change', status: 'running' });

    const currentMeta = getTask(taskId);
    const conflictWarning = buildConflictWarning(taskId, currentMeta.projectDir);
    const scopeConstraint = buildScopeConstraint(currentMeta);

    // sid 为空（手动重开后 / 首次）时构造最近对话衔接新会话
    let resumeSid = currentSession.claudeSessionId;
    let recentContext = null;
    if (!resumeSid) recentContext = buildRecentContext(taskId, sessionId);

    const agent = createClaudeAgent(
      taskId, currentMeta.projectDir, resumeSid,
      currentMeta.dangerouslySkipPermissions,
      conflictWarning, scopeConstraint, recentContext,
      sessionId,   // ← 任务会话 id，进 toolCtx 供 signal 等工具使用
      rt.toolErrors ?? [],   // ← 上轮工具失败回执，进本轮 digest 告警
    );
    rt.toolErrors = [];
    rt.agent = agent;

    try {
      await agent.sendMessage(
        msg.content,
        (chunk) => {
          rt.partialText += chunk;
          broadcastTo(taskId, sessionId, { type: 'chunk', text: chunk });
        },
        ({ sessionId: newSid, fullText, contextTokens, contextWindow, contextOverflow, toolErrors }) => {
          // ⚠️ 撑爆仅提示，不清 sid、不自动重开（上下文计算不准确，仅支持手动重开）
          if (contextOverflow) {
            broadcastTo(taskId, sessionId, {
              type: 'context_overflow_notice',
              message: '上下文已撑爆（Claude 报 Prompt too long / thrashing）。请点击「↻ 重开会话」手动重开，新会话将读取任务文件恢复上下文。',
            });
          } else {
            setSessionSid(taskId, sessionId, newSid, contextTokens, contextWindow);
          }
          appendSessionMessage(taskId, sessionId, {
            role: 'assistant', content: fullText,
            timestamp: new Date().toISOString(),
            toolCalls: [...rt.roundToolCalls],
          });
          rt.roundToolCalls = [];
          rt.toolErrors = toolErrors ?? [];
          broadcastTo(taskId, sessionId, { type: 'done', sessionId: newSid });
        },
        (name, input) => {
          rt.roundToolCalls.push({ name, input });
          broadcastTo(taskId, sessionId, { type: 'tool_call', name, input });
        },
        (data) => {
          // 工具广播：会话级事件只发本会话 listeners；status_change（聚合）发全任务
          if (data.type === 'status_change') broadcastTask(taskId, data);
          else broadcastTo(taskId, sessionId, data);
        },
      );
    } catch (err) {
      updateSessionStatus(taskId, sessionId, 'error');
      broadcastTo(taskId, sessionId, { type: 'session_status_change', sessionId, status: 'error' });
      broadcastTask(taskId, { type: 'status_change', status: aggregateStatus(getTask(taskId)) });
      broadcastTo(taskId, sessionId, { type: 'error', message: err.message });
    } finally {
      rt.processing = false;
    }
  });

  ws.on('close', () => {
    rt.listeners.delete(ws);
    if (rt.listeners.size === 0 && !rt.processing) {
      sessionRuntimes.delete(`${taskId}:${sessionId}`);
    }
  });
});

function buildRecentContext(taskId, sessionId) {
  let msgs;
  try { msgs = readSessionMessages(taskId, sessionId); } catch { return null; }
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
    `完整对话历史存储于 .task-manager/${taskId}/sessions/${sessionId}/messages.jsonl（JSONL 格式，每行一条消息，含 role/content/timestamp/toolCalls）。`,
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

// 冲突检测：任一同目录会话 running 即触发（不限主会话）
function buildConflictWarning(currentTaskId, projectDir) {
  const conflicts = listRunningSessions().filter(
    r => !(r.taskId === currentTaskId) && isConflict(r.projectDir, projectDir),
  );
  if (!conflicts.length) return null;
  const lines = [
    '[⚠️ 目录冲突提醒 - 必读]',
    '以下任务正在操作相同或相关的项目目录：',
    ...conflicts.map(r => `  · "${r.title}"（running）- ${r.projectDir}`),
    '',
    '你必须在开始任何实质性代码改动之前：',
    '1. 主动告知用户检测到潜在的目录冲突',
    '2. 询问本次任务计划改动的文件范围',
    '3. 确认与其他任务不会冲突，或与用户商议使用隔离工作区',
    '在用户明确确认前，不要执行任何文件写入操作。',
  ];
  return lines.join('\n');
}

const PORT = process.env.PORT || 7878;
server.listen(PORT, () => {
  console.log(`Task Manager server running on http://localhost:${PORT}`);
});
