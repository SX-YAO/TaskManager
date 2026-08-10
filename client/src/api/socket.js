/**
 * 创建任务会话 WebSocket 连接封装
 * @param {string} taskId
 * @param {{ type: 'main' } | { type: 'sub', sessionId: string }} session
 */
export function createTaskSocket(taskId, session) {
  const qs = session.type === 'main'
    ? `taskId=${taskId}&type=main`
    : `taskId=${taskId}&type=sub&sessionId=${session.sessionId}`;
  const ws = new WebSocket(`ws://${location.host}/ws?${qs}`);
  const listeners = {};

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      listeners[msg.type]?.forEach(cb => cb(msg));
      listeners['*']?.forEach(cb => cb(msg));
    } catch {}
  };

  return {
    on(event, cb) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    },
    close() {
      ws.close();
    },
  };
}
