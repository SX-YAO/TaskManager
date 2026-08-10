/**
 * 创建任务 WebSocket 连接封装
 * @param {string} taskId
 * @returns {{ on(event:string, cb:Function):void, send(data:object):void, close():void }}
 */
export function createTaskSocket(taskId) {
  const ws = new WebSocket(`ws://${location.host}/ws?taskId=${taskId}`);
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
