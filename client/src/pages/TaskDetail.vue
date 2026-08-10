<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useTheme } from '../composables/useTheme.js';

const { theme, toggle: toggleTheme } = useTheme();
import { http } from '../api/http.js';
import { createTaskSocket } from '../api/socket.js';
import ChatPanel from '../components/ChatPanel.vue';
import InfoPanel from '../components/InfoPanel.vue';
import OutputPanel from '../components/OutputPanel.vue';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

const task        = ref(null);
const messages    = ref([]);
const streaming   = ref(false);
const streamText  = ref('');
const thinking    = ref(false);
const toolCalls   = ref([]);
const wsConnected  = ref(false);   // WebSocket 是否已连接
const autoStarted  = ref(false);   // 防止重复自动发送
let socket = null;

// 面板宽度
const infoPanelWidth  = ref(280);
const outputPanelWidth = ref(560);

// 产出物面板（合并 diff + 文档）
const showOutput     = ref(false);
const outputTab      = ref('diff');    // 'diff' | 'docs'
const outputArtifact = ref(null);      // 从 InfoPanel 点击直接打开指定文档
const outputDiffFile = ref('');        // 从 InfoPanel 点击 diff 文件时预选
const outputRefresh  = ref(0);         // agent done 后递增触发刷新

function openOutput(tab = 'diff', artifact = null) {
  outputTab.value      = tab;
  outputArtifact.value = artifact;
  showOutput.value     = true;
}

function onOpenArtifact(category, filename) {
  openOutput('docs', { category, filename });
}

// InfoPanel 代码改动区块：点击文件 → 打开 OutputPanel 并定位到该文件
function onOpenDiff(filePath) {
  outputDiffFile.value = filePath;
  openOutput('diff');
}

// 拖拽状态
let startX = 0;
let startWidth = 0;
let resizingPanel = null;

function startResize(e, panel) {
  startX = e.clientX;
  startWidth = panel === 'info' ? infoPanelWidth.value : outputPanelWidth.value;
  resizingPanel = panel;
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
}

function onResize(e) {
  const delta = startX - e.clientX;
  if (resizingPanel === 'info') {
    infoPanelWidth.value   = Math.min(420, Math.max(220, startWidth + delta));
  } else if (resizingPanel === 'output') {
    outputPanelWidth.value = Math.min(1400, Math.max(320, startWidth + delta));
  }
}

function stopResize() {
  document.body.style.userSelect = '';
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
  resizingPanel = null;
}


async function init() {
  try {
    task.value = await http.getTask(props.id);
    messages.value = await http.getMessages(props.id);
    connectSocket();
  } catch (e) {
    console.error('加载任务失败:', e);
    router.push('/');
  }
}

function connectSocket() {
  socket = createTaskSocket(props.id);

  // 服务端确认连接
  socket.on('connected', () => {
    wsConnected.value = true;
    // 重连到正在运行的任务：显示 loading，等待服务端补发的 chunk
    if (task.value?.status === 'running') {
      thinking.value = true;
    }
    // 新任务（无历史消息）→ 自动发送任务目的，启动 AI 工作流
    if (!autoStarted.value && messages.value.length === 0 && task.value?.purpose) {
      autoStarted.value = true;
      onSend(task.value.purpose);
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

  socket.on('done', async () => {
    messages.value.push({
      role: 'assistant',
      content: streamText.value,
      timestamp: new Date().toISOString(),
      toolCalls: [],
    });
    streamText.value = '';
    streaming.value = false;
    thinking.value = false;
    toolCalls.value = [];
    // 刷新 task 状态（idle/running 由服务端维护）
    try { task.value = await http.getTask(props.id); } catch { /* 忽略 */ }
    // 产出物面板打开时，agent 完成后自动刷新
    if (showOutput.value) outputRefresh.value++;
  });

  // 工具信号触发的状态变更（pending / reviewing / idle / error）
  socket.on('status_change', ({ status }) => {
    if (task.value) task.value.status = status;
  });

  // AI 声明改动范围后，刷新 task 的 watchedRepos
  socket.on('repos_updated', async () => {
    try { task.value = await http.getTask(props.id); } catch { /* 忽略 */ }
  });

  // 旧 interrupted 事件兼容（服务端已改为 status_change，保留兜底）
  socket.on('interrupted', () => {
    streaming.value = false;
    streamText.value = '';
    thinking.value = false;
    toolCalls.value = [];
    if (task.value) task.value.status = 'reviewing';
  });

  socket.on('error', ({ message: errMsg }) => {
    streaming.value = false;
    streamText.value = '';
    thinking.value = false;
    toolCalls.value = [];
    if (task.value) task.value.status = 'error';
    messages.value.push({
      role: 'assistant',
      content: `⚠️ 错误：${errMsg}`,
      timestamp: new Date().toISOString(),
      toolCalls: [],
    });
  });

  // 上下文超阈值自动重开会话：提示用户本轮已开新会话
  socket.on('context_reset', async ({ message }) => {
    messages.value.push({
      role: 'assistant',
      content: `🔄 ${message}`,
      timestamp: new Date().toISOString(),
      toolCalls: [],
    });
    // 同步 task（sid 已清、contextTokens 已置空），前端用量百分比立即归零
    try { task.value = await http.getTask(props.id); } catch { /* 忽略 */ }
  });
}

function onStop() {
  socket.send({ type: 'stop' });
  // 乐观：立即把流式内容固化为中断消息，清空流式状态
  if (streamText.value) {
    messages.value.push({
      role: 'assistant',
      content: streamText.value,
      timestamp: new Date().toISOString(),
      toolCalls: [],
      interrupted: true,
    });
  }
  streamText.value = '';
  streaming.value = false;
  thinking.value = false;
  toolCalls.value = [];
  // 停止后统一 reviewing（任务已运行过，不回到 idle）
  if (task.value) task.value.status = 'reviewing';
}

// 手动重开会话：清当前 sid，下次发消息开新会话
async function onResetContext() {
  try {
    const r = await http.resetContext(props.id);
    messages.value.push({
      role: 'assistant',
      content: `🔄 ${r.message}`,
      timestamp: new Date().toISOString(),
      toolCalls: [],
    });
    task.value = await http.getTask(props.id);   // 刷新（sid 已清，按钮随之隐藏）
  } catch { /* 忽略 */ }
}

function onSend(content) {
  messages.value.push({
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
    toolCalls: [],
  });
  streamText.value = '';
  thinking.value = true;
  toolCalls.value = [];
  // 乐观更新 header 状态
  if (task.value) task.value.status = 'running';
  socket.send({ type: 'message', content });
}

onMounted(init);
onUnmounted(() => {
  socket?.close();
  stopResize();
});
</script>

<template>
  <div class="layout" v-if="task">
    <header class="detail-header">
      <button class="back-btn" @click="router.push('/')">← 返回</button>
      <span class="detail-title">{{ task.title }}</span>
      <span class="detail-status" :class="task.status">
        {{ {
          idle: '未运行', running: '处理中', pending: '待确认',
          reviewing: '验收中', error: '异常', archived: '已归档',
          paused: '空闲待续', interrupted: '已中断'
        }[task.status] ?? task.status }}
      </span>
      <span class="ws-dot" :class="wsConnected ? 'connected' : 'connecting'"
            :title="wsConnected ? '已连接' : '连接中…'">
      </span>
      <!-- 文档产出按钮（代码改动已移至 InfoPanel）-->
      <button
        class="diff-toggle-btn"
        :class="{ active: showOutput }"
        title="文档产出"
        @click="showOutput ? showOutput = false : openOutput('docs')"
      >文档</button>
      <button class="btn-icon-sm" :title="theme === 'dark' ? '切换浅色模式' : '切换深色模式'" @click="toggleTheme">
        {{ theme === 'dark' ? '☀️' : '🌙' }}
      </button>
    </header>

    <div class="detail-body">
      <ChatPanel
        :messages="messages"
        :streaming="streaming"
        :stream-text="streamText"
        :thinking="thinking"
        :tool-calls="toolCalls"
        :ws-connected="wsConnected"
        :task="task"
        :task-status="task.status"
        @send="onSend"
        @stop="onStop"
        @reset-context="onResetContext"
      />

      <div class="resize-handle" @mousedown="startResize($event, 'info')"></div>

      <InfoPanel
        :task-id="id"
        :task="task"
        :style="{ width: infoPanelWidth + 'px' }"
        @open-artifact="onOpenArtifact"
        @open-diff="onOpenDiff"
        @task-updated="(t) => { task = t }"
      />

      <template v-if="showOutput">
        <div class="resize-handle" @mousedown="startResize($event, 'output')"></div>
        <OutputPanel
          :task-id="id"
          :task="task"
          :refresh-trigger="outputRefresh"
          :initial-tab="outputTab"
          :initial-artifact="outputArtifact"
          :initial-diff-file="outputDiffFile"
          :style="{ width: outputPanelWidth + 'px' }"
          @close="showOutput = false"
        />
      </template>
    </div>
  </div>

  <div v-else class="loading">加载中…</div>
</template>

<style scoped>
.layout { display: flex; flex-direction: column; height: 100vh; }
.detail-header {
  background: var(--bg-surface); border-bottom: 1px solid var(--border);
  padding: 0 20px; height: 52px;
  display: flex; align-items: center; gap: 12px; flex-shrink: 0;
}
.back-btn {
  background: transparent; border: 1px solid var(--border); color: #888;
  border-radius: 7px; padding: 5px 11px; font-size: 12px; cursor: pointer;
}
.back-btn:hover { border-color: #444; color: #ccc; }
.btn-icon-sm {
  width: 30px; height: 30px; background: transparent; border: none;
  border-radius: 7px; font-size: 14px; cursor: pointer; display: flex;
  align-items: center; justify-content: center; transition: background .12s;
}
.btn-icon-sm:hover { background: var(--bg-hover); }
.detail-title { font-size: 14px; font-weight: 600; }
.detail-status {
  font-size: 11px; font-weight: 500; padding: 3px 8px;
  border-radius: 10px;
}
.detail-status.running     { background: rgba(64,192,87,.12);   color: #40c057; }
.detail-status.pending     { background: rgba(245,159,0,.12);   color: #f59f00; }
.detail-status.reviewing   { background: rgba(59,130,246,.12);  color: #4090e0; }
.detail-status.error       { background: rgba(224,49,49,.12);   color: #e06060; }
.detail-status.idle        { background: #1e1e2a;               color: var(--text-muted); }
/* 旧状态兼容 */
.detail-status.interrupted { background: rgba(193,119,0,.12);  color: #c17700; }
.detail-status.paused      { background: rgba(51,154,240,.1);  color: #4dabf7; }
.diff-toggle-btn {
  margin-left: auto;
  padding: 4px 10px; font-size: 11px; font-weight: 600;
  background: transparent; border: 1px solid var(--border);
  border-radius: 7px; color: #555; cursor: pointer;
  transition: all 0.12s;
}
.diff-toggle-btn:hover  { border-color: #7b8cde; color: #7b8cde; }
.diff-toggle-btn.active { background: rgba(59,91,219,0.12); border-color: #3b5bdb; color: #7b8cde; }

.ws-dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  transition: background 0.3s;
}
.ws-dot.connected  { background: #40c057; box-shadow: 0 0 5px rgba(64,192,87,.4); }
.ws-dot.connecting { background: #555; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:1} }

.detail-body { flex: 1; display: flex; overflow: hidden; }
.resize-handle {
  width: 6px; flex-shrink: 0; cursor: col-resize;
  background: #2a2a38; transition: background 0.15s;
}
.resize-handle:hover { background: #3b5bdb; }
.loading { display: flex; align-items: center; justify-content: center; height: 100vh; color: #555; }
</style>
