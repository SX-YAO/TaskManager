<script setup>
import { toRef } from 'vue';
import { useSessionChat } from '../composables/useSessionChat.js';
import ChatPanel from './ChatPanel.vue';

const props = defineProps({
  taskId:  { type: String,  required: true },
  session: { type: Object,  required: true },   // 会话对象（reactive）
  task:    { type: Object,  required: true },
  split:   { type: Boolean, default: false },   // 双栏模式：显示 pane 头
});
const emit = defineEmits(['merge', 'done']);

// 单个会话的聊天状态机；done 转发给父组件（TaskDetail 刷新产出物面板用）
const {
  messages, streaming, streamText, thinking, toolCalls, wsConnected,
  send, stop, resetContext, loadHistory, connect, close,
} = useSessionChat(props.taskId, toRef(props, 'session'), toRef(props, 'task'), {
  onDone: () => emit('done'),
});

// 生命周期由父组件统一控制：TaskDetail onMounted 后逐个 loadHistory() + connect()
defineExpose({ loadHistory, connect, close, send, wsConnected });
</script>

<template>
  <div class="chat-pane">
    <div v-if="split" class="pane-head">
      <span class="dot" :class="session.status"></span>
      <b>{{ session.name }}</b>
      <button class="merge-x" title="合并回单栏" @click="emit('merge')">✕</button>
    </div>
    <ChatPanel
      :messages="messages"
      :streaming="streaming"
      :stream-text="streamText"
      :thinking="thinking"
      :tool-calls="toolCalls"
      :ws-connected="wsConnected"
      :task="task"
      :session="session"
      :session-status="session.status"
      @send="send"
      @stop="stop"
      @reset-context="resetContext"
    />
  </div>
</template>

<style scoped>
.chat-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.pane-head {
  height: 34px; flex-shrink: 0; display: flex; align-items: center; gap: 8px;
  padding: 0 14px; border-bottom: 1px solid var(--border-sub);
  background: var(--bg-surface-2); font-size: 12px;
}
.pane-head .dot { width: 6px; height: 6px; border-radius: 50%; background: #3a3a4e; }
.pane-head .dot.running   { background: #40c057; box-shadow: 0 0 5px rgba(64,192,87,.5); }
.pane-head .dot.pending   { background: #f59f00; }
.pane-head .dot.reviewing { background: #4090e0; }
.pane-head .dot.closed    { background: transparent; border: 1px solid #33334a; }
.merge-x {
  margin-left: auto; width: 20px; height: 20px; border-radius: 5px;
  border: 1px solid var(--border); background: transparent;
  color: var(--text-muted); font-size: 11px; cursor: pointer;
}
.merge-x:hover { border-color: #c92a2a; color: #e03131; }
</style>
