/**
 * 运行态会话表（内存，不落盘）
 * key: `${taskId}:${sessionId}` → { agent, listeners, processing, partialText, roundToolCalls }
 * index.js（WS）与 router.js（关闭会话时停 agent）共享。
 */
export const sessionRuntimes = new Map();

export function runtimeKey(taskId, sessionId) {
  return `${taskId}:${sessionId}`;
}

export function getRuntime(taskId, sessionId) {
  const key = runtimeKey(taskId, sessionId);
  if (!sessionRuntimes.has(key)) {
    sessionRuntimes.set(key, {
      agent: null, listeners: new Set(),
      processing: false, partialText: '', roundToolCalls: [],
    });
  }
  return sessionRuntimes.get(key);
}

export function broadcastTo(taskId, sessionId, data) {
  const str = JSON.stringify(data);
  sessionRuntimes.get(runtimeKey(taskId, sessionId))?.listeners.forEach(ws => {
    if (ws.readyState === 1) ws.send(str);
  });
}

// 广播到任务下所有会话的 listeners（聚合状态变更等任务级事件用）
export function broadcastTask(taskId, data) {
  const str = JSON.stringify(data);
  for (const [key, rt] of sessionRuntimes) {
    if (!key.startsWith(`${taskId}:`)) continue;
    rt.listeners.forEach(ws => { if (ws.readyState === 1) ws.send(str); });
  }
}

// 停止某会话的 agent 进程（关闭会话 / stop 消息用）
export function stopRuntime(taskId, sessionId) {
  const rt = sessionRuntimes.get(runtimeKey(taskId, sessionId));
  if (rt?.processing && rt.agent) rt.agent.stop();
  return rt;
}
