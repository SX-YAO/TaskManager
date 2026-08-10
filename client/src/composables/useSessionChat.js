import { ref } from 'vue';
import { http } from '../api/http.js';
import { createTaskSocket } from '../api/socket.js';

/**
 * 单个会话的聊天状态机（每个 pane 一个实例）
 * @param {string} taskId
 * @param {import('vue').Ref<object>} sessionRef  会话对象（status 由本 composable 直接更新）
 * @param {import('vue').Ref<object>} taskRef     任务对象（聚合 status 更新用）
 * @param {{ onDone?: () => void }} [hooks]       可选回调（done 时通知父组件刷新产出物面板）
 */
export function useSessionChat(taskId, sessionRef, taskRef, hooks = {}) {
  const messages    = ref([]);
  const streaming   = ref(false);
  const streamText  = ref('');
  const thinking    = ref(false);
  const toolCalls   = ref([]);
  const wsConnected = ref(false);
  let socket = null;
  let autoStarted = false;

  const isMain = sessionRef.value.isMain;

  async function loadHistory() {
    messages.value = await http.getSessionMessages(taskId, sessionRef.value.id);
  }

  function connect() {
    const desc = isMain
      ? { type: 'main' }
      : { type: 'sub', sessionId: sessionRef.value.id };
    socket = createTaskSocket(taskId, desc);

    // 服务端确认连接
    socket.on('connected', () => {
      wsConnected.value = true;
      // 重连到正在运行的会话：显示 loading，等待服务端补发的 chunk
      if (sessionRef.value.status === 'running') thinking.value = true;
      // 仅主会话保留「新任务自动发 purpose」行为
      if (isMain && !autoStarted && messages.value.length === 0 && taskRef.value?.purpose) {
        autoStarted = true;
        send(taskRef.value.purpose);
      }
    });

    socket.on('chunk', ({ text }) => {
      thinking.value = false;
      streaming.value = true;
      streamText.value += text;
    });

    socket.on('tool_call', ({ name, input }) => {
      toolCalls.value.push({ name, input, ts: Date.now() });
    });

    socket.on('done', () => {
      if (streamText.value) {
        messages.value.push({
          role: 'assistant', content: streamText.value,
          timestamp: new Date().toISOString(), toolCalls: [],
        });
      }
      streamText.value = '';
      streaming.value = false;
      thinking.value = false;
      toolCalls.value = [];
      hooks.onDone?.();
    });

    // 会话级状态变更（pending / reviewing / idle / error）
    socket.on('session_status_change', ({ sessionId, status }) => {
      if (sessionId === sessionRef.value.id) sessionRef.value.status = status;
    });

    // 任务级聚合状态变更（更新 header 的任务状态）
    socket.on('status_change', ({ status }) => {
      if (taskRef.value) taskRef.value.status = status;
    });

    // AI 声明改动范围后，刷新 task 的 watchedRepos
    socket.on('repos_updated', async () => {
      try { taskRef.value = await http.getTask(taskId); } catch { /* 忽略 */ }
    });

    socket.on('error', ({ message: errMsg }) => {
      streaming.value = false;
      streamText.value = '';
      thinking.value = false;
      toolCalls.value = [];
      messages.value.push({
        role: 'assistant', content: `⚠️ 错误：${errMsg}`,
        timestamp: new Date().toISOString(), toolCalls: [],
      });
    });

    // 撑爆仅提示（手动重开由用户点按钮触发，不做任何自动 reset）
    socket.on('context_overflow_notice', ({ message }) => {
      messages.value.push({
        role: 'assistant', content: `⚠️ ${message}`,
        timestamp: new Date().toISOString(), toolCalls: [],
      });
    });

    // 手动重开后服务端确认（sid 已清、contextTokens 已置空）
    socket.on('context_reset', async ({ message }) => {
      messages.value.push({
        role: 'assistant', content: `🔄 ${message}`,
        timestamp: new Date().toISOString(), toolCalls: [],
      });
      try { taskRef.value = await http.getTask(taskId); } catch { /* 忽略 */ }
    });

    // 旧 interrupted 事件兼容（服务端已改为 session_status_change，保留兜底）
    socket.on('interrupted', () => {
      streaming.value = false;
      streamText.value = '';
      thinking.value = false;
      toolCalls.value = [];
      sessionRef.value.status = 'reviewing';
    });
  }

  function send(content) {
    messages.value.push({ role: 'user', content, timestamp: new Date().toISOString(), toolCalls: [] });
    streamText.value = '';
    thinking.value = true;
    toolCalls.value = [];
    // 乐观更新会话与任务状态
    sessionRef.value.status = 'running';
    if (taskRef.value) taskRef.value.status = 'running';
    socket.send({ type: 'message', content });
  }

  function stop() {
    socket.send({ type: 'stop' });
    // 乐观：立即把流式内容固化为中断消息，清空流式状态
    if (streamText.value) {
      messages.value.push({
        role: 'assistant', content: streamText.value,
        timestamp: new Date().toISOString(), toolCalls: [], interrupted: true,
      });
    }
    streamText.value = '';
    streaming.value = false;
    thinking.value = false;
    toolCalls.value = [];
    // 停止后统一 reviewing（会话已运行过，不回到 idle）
    sessionRef.value.status = 'reviewing';
  }

  // 手动重开会话：清当前 sid，下次发消息开新会话
  async function resetContext() {
    try {
      const r = await http.resetSessionContext(taskId, sessionRef.value.id);
      sessionRef.value.claudeSessionId = null;
      sessionRef.value.contextTokens = null;
      messages.value.push({
        role: 'assistant', content: `🔄 ${r.message}`,
        timestamp: new Date().toISOString(), toolCalls: [],
      });
    } catch { /* 忽略 */ }
  }

  function close() { socket?.close(); }

  return { messages, streaming, streamText, thinking, toolCalls, wsConnected,
           send, stop, resetContext, loadHistory, connect, close };
}
