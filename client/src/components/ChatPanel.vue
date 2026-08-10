<script setup>
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  messages:    { type: Array,   default: () => [] },
  streaming:   { type: Boolean, default: false },
  streamText:  { type: String,  default: '' },
  thinking:    { type: Boolean, default: false },
  toolCalls:   { type: Array,   default: () => [] },
  wsConnected: { type: Boolean, default: false },
  task:        { type: Object,  default: null },
  taskStatus:  { type: String,  default: '' },  // 任务状态（idle/running/pending/reviewing/error）
});

const emit = defineEmits(['send', 'stop', 'reset-context']);

const input   = ref('');
const listEl  = ref(null);
const textareaEl = ref(null);

// 输入框自适应高度：每多一个换行增加一个行高（19.5px），封顶 3 倍基准（114px）
const BASE_HEIGHT = 38;       // 1 行容器高（含 padding）
const LINE_STEP   = 19.5;     // 单行行高 = font-size(13) × line-height(1.5)
const MAX_HEIGHT  = BASE_HEIGHT * 3;
function autoResize() {
  const el = textareaEl.value;
  if (!el) return;
  const newlineCount = (input.value.match(/\n/g) || []).length;
  el.style.height = Math.min(BASE_HEIGHT + newlineCount * LINE_STEP, MAX_HEIGHT) + 'px';
}
watch(input, () => { nextTick(autoResize); });

// 当前是否处于处理中（发送按钮变停止按钮）
const isProcessing = computed(() => props.thinking || props.streaming);

// 状态提示条（pending / reviewing / error）
const statusBar = computed(() => {
  switch (props.taskStatus) {
    case 'pending':   return { show: true, text: 'Agent 需要你的确认才能继续', icon: '🔔', cls: 'bar-pending' };
    case 'reviewing': return { show: true, text: '本轮产出已完成，可查看改动或继续发消息', icon: '📋', cls: 'bar-reviewing' };
    case 'error':     return { show: true, text: 'Agent 进程异常退出，发消息可重新启动', icon: '⚠️', cls: 'bar-error' };
    default:          return { show: false };
  }
});

// agent 状态描述（用于状态条）
const agentStatus = computed(() => {
  if (!props.wsConnected)    return { text: '连接中…',     color: '#555',    dot: false };
  if (props.thinking)        return { text: '思考中',       color: '#fab005', dot: true };
  if (props.toolCalls.length) return { text: `执行工具`,    color: '#7b8cde', dot: true };
  if (props.streaming)       return { text: '输出中',       color: '#40c057', dot: true };
  return { text: '就绪',     color: '#40c057', dot: false };
});

// 上下文用量：真实占用（task.contextTokens，来自会话文件最后一条 assistant usage）
// / 真实窗口大小（task.contextWindow，来自 modelUsage.contextWindow）
const contextPercent = computed(() => {
  const t = props.task?.contextTokens;
  const w = props.task?.contextWindow || 1_000_000;   // 兜底 1M
  if (!t) return 0;
  return Math.min(100, Math.round(t / w * 100));
});

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function send() {
  const content = input.value.trim();
  if (!content || isProcessing.value) return;
  emit('send', content);
  input.value = '';
  atBottom.value = true;       // 用户主动发送，恢复跟随到底
  nextTick(scrollToBottom);
}

function stop() {
  emit('stop');
}
function resetContext() {
  emit('reset-context');
}

function onKeydown(e) {
  // e.isComposing = true 时处于 IME 组合输入过程（如中文拼音选字）
  // 此时回车是选字确认，不应触发发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!isProcessing.value) send();
  }
}

// 智能滚动：用户在底部时跟随到底；不在底部时只显示「新消息」提示，不打断阅读
// atBottom 跟踪用户滚动意图（由 onScroll 更新），不能用实时几何判断——
// 流式输出让 scrollHeight 增长后，旧 scrollTop 会误判为「不在底部」
const SCROLL_THRESHOLD = 30;   // 距底部多少像素内仍视为「在底部」
const newMsgHint = ref(false);
const atBottom   = ref(true);

function isAtBottom() {
  const el = listEl.value;
  if (!el) return true;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD;
}
function scrollToBottom() {
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onScroll() {
  atBottom.value = isAtBottom();
  if (atBottom.value) newMsgHint.value = false;
}
function jumpToBottom() {
  atBottom.value = true;
  scrollToBottom();
  newMsgHint.value = false;
}

watch(
  () => [props.messages.length, props.streamText, props.toolCalls.length, props.thinking],
  async () => {
    await nextTick();
    if (!listEl.value) return;
    if (atBottom.value) { scrollToBottom(); newMsgHint.value = false; }
    else newMsgHint.value = true;
  }
);
// 切换任务：重置提示并滚到底
watch(() => props.task?.id, async () => {
  newMsgHint.value = false;
  atBottom.value = true;
  await nextTick(); scrollToBottom();
});

// Braille spinner
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const frame  = ref(0);
let timer    = null;
onMounted(() => { timer = setInterval(() => { frame.value = (frame.value + 1) % FRAMES.length; }, 100); });
onUnmounted(() => clearInterval(timer));

const TOOL_ICONS = { Read: '📖', Write: '✏️', Edit: '✏️', Bash: '⚡', Task: '📋' };

function toolDesc({ name, input: inp }) {
  const icon   = TOOL_ICONS[name] ?? '🔧';
  const detail = name === 'Bash'
    ? (inp.command ?? '').slice(0, 55)
    : (inp.file_path ?? JSON.stringify(inp).slice(0, 55));
  return `${icon} ${name}  ${detail}`;
}
</script>

<template>
  <div class="chat-panel">

    <!-- 状态提示条（pending / reviewing / error） -->
    <div v-if="statusBar.show" class="status-bar" :class="statusBar.cls">
      <span class="bar-icon">{{ statusBar.icon }}</span>
      <span>{{ statusBar.text }}</span>
    </div>

    <!-- 消息列表 -->
    <div class="messages" ref="listEl" @scroll="onScroll">

      <!-- 空状态 -->
      <div v-if="!messages.length && !thinking && !streaming" class="empty-state">
        <div class="empty-icon">✦</div>
        <div class="empty-title">{{ wsConnected ? '连接就绪' : '连接中…' }}</div>
        <div v-if="task?.purpose" class="empty-purpose">{{ task.purpose }}</div>
        <div class="empty-hint">
          {{ wsConnected
            ? 'Agent 会先读取任务文件了解背景，然后开始工作'
            : '正在建立会话连接，请稍候' }}
        </div>
      </div>

      <!-- 历史消息 -->
      <div
        v-for="(msg, i) in messages" :key="i"
        class="msg" :class="msg.role"
      >
        <div class="avatar" :class="msg.role">
          {{ msg.role === 'assistant' ? '✦' : '我' }}
        </div>
        <div class="msg-body">
          <div class="msg-meta">
            <span class="msg-name">{{ msg.role === 'assistant' ? 'Claude' : '我' }}</span>
            <span class="msg-time">{{ fmtTime(msg.timestamp) }}</span>
            <span v-if="msg.interrupted" class="interrupted-badge">⊘ 已中断</span>
          </div>
          <!-- 历史工具调用（落盘后重新加载时展示） -->
          <div v-for="(tc, j) in (msg.toolCalls || [])" :key="j" class="tool-pill">
            {{ toolDesc(tc) }}
          </div>
          <!-- pending 时最后一条 AI 消息高亮，引导用户回复 -->
          <div
            class="bubble"
            :class="{
              interrupted: msg.interrupted,
              'pending-highlight': taskStatus === 'pending' && msg.role === 'assistant' && i === messages.length - 1
            }"
          >{{ msg.content }}</div>
        </div>
      </div>

      <!-- 实时：thinking / toolCalls / streaming -->
      <div v-if="thinking || toolCalls.length || streamText" class="msg assistant">
        <div class="avatar assistant">✦</div>
        <div class="msg-body">
          <div class="msg-meta">
            <span class="msg-name">Claude</span>
          </div>

          <!-- thinking spinner -->
          <div v-if="thinking && !streamText && !toolCalls.length" class="bubble thinking">
            <span class="spinner">{{ FRAMES[frame] }}</span> 正在思考…
          </div>

          <!-- 工具调用 pills -->
          <div v-for="(tc, j) in toolCalls" :key="j" class="tool-pill">
            {{ toolDesc(tc) }}
          </div>

          <!-- 流式文本 -->
          <div v-if="streamText" class="bubble">
            {{ streamText }}<span v-if="streaming" class="cursor"></span>
          </div>
        </div>
      </div>

    </div>

    <!-- 新消息提示（用户不在底部且有新消息时显示，点击滚动到底） -->
    <div v-if="newMsgHint" class="new-msg-hint" @click="jumpToBottom">
      <span class="nmh-text">↓ 有新消息，点击查看</span>
    </div>

    <!-- agent 状态条 -->
    <div class="agent-status-bar">
      <span class="status-indicator" :style="{ '--c': agentStatus.color }">
        <span v-if="agentStatus.dot" class="status-dot" :style="{ background: agentStatus.color }"></span>
        {{ agentStatus.text }}
      </span>
      <span v-if="isProcessing" class="processing-hint">按 ■ 可中断</span>
      <span
        v-if="contextPercent"
        class="ctx-hint"
        :class="{ 'ctx-warn': contextPercent >= 80 }"
        :title="`上下文占用 ${contextPercent}%`"
      >上下文 {{ contextPercent }}%</span>
      <button
        v-if="task?.claudeSessionId && !isProcessing"
        class="reset-ctx-btn"
        title="放弃当前会话，下次发消息开新会话并读取任务文件恢复上下文"
        @click="resetContext"
      >↻ 重开会话</button>
    </div>

    <!-- 输入区 -->
    <div class="input-wrap" :class="{ 'input-pending': taskStatus === 'pending' }">
      <textarea
        ref="textareaEl"
        v-model="input"
        :placeholder="taskStatus === 'pending' ? '回复 Agent，按 Enter 发送…' : '输入消息，Enter 发送，Shift+Enter 换行…'"
        rows="1"
        :disabled="isProcessing"
        @keydown="onKeydown"
      ></textarea>

      <!-- 发送 / 停止 按钮切换 -->
      <button v-if="!isProcessing" class="send-btn" :disabled="!input.trim()" @click="send">
        ↑
      </button>
      <button v-else class="stop-btn" title="停止当前 Agent" @click="stop">
        ■
      </button>
    </div>

  </div>
</template>

<style scoped>
.chat-panel {
  display: flex; flex-direction: column; flex: 1; min-width: 180px;
  border-right: 1px solid var(--border);
  background: var(--bg-base);
}

/* ── 消息列表 ── */
.messages {
  flex: 1; overflow-y: auto;
  padding: 24px 24px 12px;
  display: flex; flex-direction: column; gap: 20px;
}

/* 空状态 */
.empty-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 12px; padding: 40px; text-align: center;
  user-select: none;
}
.empty-icon {
  font-size: 30px;
  background: linear-gradient(135deg, #3b5bdb, #7048e8);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
.empty-title  { font-size: 14px; font-weight: 600; color: var(--text-muted); }
.empty-purpose {
  font-size: 12px; color: #444; line-height: 1.65; max-width: 320px;
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 14px; text-align: left;
}
.empty-hint { font-size: 11px; color: #333; max-width: 260px; line-height: 1.6; }

/* ── 消息行 ── */
.msg {
  display: flex; gap: 8px; align-items: flex-end;
  max-width: 100%;
}

/* 用户消息：右对齐，头像在右 */
.msg.user {
  flex-direction: row-reverse;
}

.avatar {
  width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
}
.avatar.assistant { background: linear-gradient(135deg, #3b5bdb, #7048e8); color: white; font-size: 12px; }
.avatar.user      { background: #252535; color: #666; font-size: 11px; }

.msg-body { max-width: calc(100% - 36px); min-width: 0; }

/* 用户消息 body 右对齐 */
.msg.user .msg-body { align-items: flex-end; display: flex; flex-direction: column; }

.msg-meta {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 4px;
}
.msg.user .msg-meta { flex-direction: row-reverse; }

.msg-name { font-size: 10px; font-weight: 600; color: var(--text-muted); }
.msg-time { font-size: 10px; color: #2a2a38; }

.interrupted-badge {
  font-size: 10px; color: #c17700;
  background: rgba(193,119,0,0.1); border: 1px solid rgba(193,119,0,0.25);
  border-radius: 10px; padding: 1px 7px;
}

/* ── 气泡 ── */
.bubble {
  font-size: 13px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  padding: 9px 13px; border-radius: 14px;
  max-width: 100%;
}

/* Agent 气泡：左侧深色 */
.msg.assistant .bubble {
  background: var(--bg-surface); color: var(--text-secondary);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}

/* 用户气泡：右侧蓝色 */
.msg.user .bubble {
  background: linear-gradient(135deg, #3b5bdb, #4c6ef5);
  color: #e8f0ff;
  border-bottom-right-radius: 4px;
}

.bubble.interrupted {
  background: #1a1510; color: #888;
  border-color: rgba(193,119,0,0.3);
  border-left: 2px solid #c17700;
}
.bubble.thinking { background: transparent; border: none; color: #555; font-size: 12px; padding: 4px 0; }

.cursor {
  display: inline-block; width: 2px; height: 13px; background: #7048e8;
  border-radius: 1px; margin-left: 2px; vertical-align: middle;
  animation: blink 1s infinite;
}
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

.spinner { display: inline-block; font-family: monospace; }

/* 工具调用 pill */
.tool-pill {
  display: inline-flex; align-items: center;
  background: var(--bg-surface); border: 1px solid #2d3561;
  border-radius: 6px; padding: 4px 10px;
  font-size: 11px; color: #7b8cde;
  font-family: "SF Mono", Menlo, monospace;
  margin: 3px 0; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── 任务状态提示条（pending / reviewing / error）── */
.status-bar {
  padding: 9px 16px; font-size: 12px; font-weight: 500;
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
}
.bar-icon { font-size: 14px; line-height: 1; }
.bar-pending   { background: rgba(245,159,0,.08); border-bottom: 1px solid rgba(245,159,0,.15); color: #c17700; }
.bar-reviewing { background: rgba(59,130,246,.07); border-bottom: 1px solid rgba(59,130,246,.12); color: #3b7dd8; }
.bar-error     { background: rgba(224,49,49,.07);  border-bottom: 1px solid rgba(224,49,49,.12);  color: #c03030; }

/* pending 时最后一条 AI 消息高亮 */
.msg.assistant .bubble.pending-highlight {
  background: rgba(245,159,0,.05);
  border-color: rgba(245,159,0,.2);
  border-left: 2px solid #f59f00;
}

/* pending 时输入区高亮 */
.input-wrap.input-pending {
  background: rgba(245,159,0,.04);
  border-top-color: rgba(245,159,0,.2);
}
.input-wrap.input-pending textarea { border-color: rgba(245,159,0,.35); }
.input-wrap.input-pending textarea:focus { border-color: #f59f00; }

/* ── 新消息提示条 ── */
.new-msg-hint {
  text-align: center;
  padding: 6px 16px;
  background: rgba(59,91,219,.08);
  border-top: 1px solid rgba(59,91,219,.18);
  color: #3b5bdb;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}
.new-msg-hint:hover { background: rgba(59,91,219,.14); }
.nmh-text { font-weight: 500; }

/* ── agent 状态条 ── */
.agent-status-bar {
  height: 28px; padding: 0 16px;
  display: flex; align-items: center; justify-content: space-between;
  border-top: 1px solid var(--border-sub);
  background: var(--bg-base);
}
.status-indicator {
  font-size: 11px; color: var(--c, #555);
  display: flex; align-items: center; gap: 5px;
}
.status-dot {
  width: 5px; height: 5px; border-radius: 50%;
  animation: pulse-dot 1.5s infinite;
}
@keyframes pulse-dot { 0%,100%{opacity:.5} 50%{opacity:1} }
.processing-hint { font-size: 10px; color: #333; }
.ctx-hint { font-size: 10px; color: #555; padding: 2px 7px; border-radius: 8px; background: rgba(0,0,0,.12); }
.ctx-hint.ctx-warn { color: #d9480f; background: rgba(245,159,0,.15); font-weight: 500; }
.reset-ctx-btn {
  font-size: 10px; color: #7b8cde; padding: 2px 8px;
  border: 1px solid rgba(59,91,219,.3); border-radius: 8px;
  background: transparent; cursor: pointer; transition: background 0.15s;
}
.reset-ctx-btn:hover { background: rgba(59,91,219,.1); }

/* ── 输入区 ── */
.input-wrap {
  padding: 12px 16px; border-top: 1px solid var(--border);
  background: var(--bg-surface-3);
  display: flex; gap: 8px; align-items: flex-end;
}
textarea {
  flex: 1; background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 9px 14px; color: var(--text-primary);
  font-size: 13px; font-family: inherit;
  resize: none; min-height: 38px; max-height: 120px;
  outline: none; transition: border-color 0.15s; line-height: 1.5;
}
textarea:focus  { border-color: #3b5bdb; }
textarea:disabled { opacity: 0.4; cursor: not-allowed; }
textarea::placeholder { color: #2a2a38; }

.send-btn, .stop-btn {
  width: 34px; height: 34px; border: none; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0; font-size: 14px;
  transition: background 0.15s;
}
.send-btn { background: #3b5bdb; color: white; }
.send-btn:hover:not(:disabled) { background: #4c6ef5; }
.send-btn:disabled { background: #1e1e2a; color: #444; cursor: not-allowed; }

.stop-btn {
  background: rgba(224,49,49,0.15);
  border: 1px solid rgba(224,49,49,0.3);
  color: #e03131; font-size: 12px;
  animation: stop-pulse 2s infinite;
}
.stop-btn:hover { background: rgba(224,49,49,0.25); }

@keyframes stop-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(224,49,49,0); }
  50%     { box-shadow: 0 0 0 4px rgba(224,49,49,0.15); }
}
</style>
