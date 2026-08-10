<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, shallowReactive } from 'vue';
import { useRouter } from 'vue-router';
import { useTheme } from '../composables/useTheme.js';

const { theme, toggle: toggleTheme } = useTheme();
import { http } from '../api/http.js';
import ChatPane from '../components/ChatPane.vue';
import SessionTabBar from '../components/SessionTabBar.vue';
import InfoPanel from '../components/InfoPanel.vue';
import OutputPanel from '../components/OutputPanel.vue';

const props = defineProps({ id: { type: String, required: true } });
const router = useRouter();

const task     = ref(null);
const sessions = ref([]);          // Session[]（会话级数据源，ChatPane 直接改 status）
const panes    = ref(['main']);    // 打开的 sessionId 数组（最多 2 个分屏）
// sessionId → ChatPane expose 实例（v-for 多模板 ref 顺序不被保证，改用函数 ref 建 Map；
// shallowReactive 让 wsConnected computed 能追踪 set/get——普通 Map 非响应式会导致状态点卡住；
// 必须 shallow，避免组件实例被深响应式包装）
const paneRefs = shallowReactive(new Map());
function setPaneRef(sid, el) {
  if (el) paneRefs.set(sid, el);
  else    paneRefs.delete(sid);
}

// header 连接状态点：取首个 pane 的 wsConnected（expose 的 ref 经 proxyRefs 已解包）
const wsConnected = computed(() => paneRefs.get(panes.value[0])?.wsConnected ?? false);

// ── 分屏状态 ──
const draggingSession = ref(null);   // 拖拽中的 sessionId（拖拽时显示落区）
const splitRatio      = ref(0.5);    // 左栏占比（0.25 ~ 0.75）

// 布局持久化：sessionStorage['taskPanes:' + taskId] = { panes, ratio }
function persistPanes() {
  sessionStorage.setItem(`taskPanes:${props.id}`,
    JSON.stringify({ panes: panes.value, ratio: splitRatio.value }));
}

// 恢复上次分屏布局（过滤已不存在的会话）；关页签后 sessionStorage 自动失效
function restorePanes() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`taskPanes:${props.id}`) ?? 'null');
    if (saved?.panes?.length) {
      const valid = saved.panes.filter(sid => sessions.value.some(s => s.id === sid));
      if (valid.length) panes.value = valid.slice(0, 2);
      if (saved.ratio) splitRatio.value = Math.min(0.75, Math.max(0.25, saved.ratio));
    }
  } catch { /* 忽略损坏的持久化数据 */ }
}

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

// 任一 pane agent done：产出物面板打开时自动刷新
function onPaneDone() {
  if (showOutput.value) outputRefresh.value++;
}

// ── SessionTabBar 事件（Task 8）──

// 初始化新出现的 pane：加载历史 + 连接 WS（已连接过的不重复 connect）
async function initPane(sid) {
  const p = paneRefs.get(sid);
  if (p && !p.wsConnected) { await p.loadHistory(); p.connect(); }
}

// 单击标签：把聚焦 pane（单栏时即最后一个 pane）切到该会话；closed 会话也可打开回看
async function onSelectSession(sessionId) {
  if (panes.value.includes(sessionId)) return;      // 已打开
  panes.value[panes.value.length - 1] = sessionId;  // 替换聚焦 pane
  persistPanes();
  await nextTick();
  // 旧 ChatPane 已随 key 变化卸载（其 onUnmounted 自动断 WS），这里只初始化新 pane
  await initPane(sessionId);
}

// 新建会话（name 可空，服务端默认命名），创建后立即切过去
async function onCreateSession(name) {
  const s = await http.createSession(props.id, name);
  sessions.value.push(s);
  await onSelectSession(s.id);
}

// 关闭子会话：closed 标签灰显删除线；pane 若开着则保留回看（只读由 Task 9 实现）
async function onCloseSession(sessionId) {
  const updated = await http.closeSession(props.id, sessionId);
  const idx = sessions.value.findIndex(s => s.id === sessionId);
  if (idx !== -1) sessions.value[idx] = updated;
}

// 双击改名
async function onRenameSession(sessionId, name) {
  const updated = await http.renameSession(props.id, sessionId, name);
  const idx = sessions.value.findIndex(s => s.id === sessionId);
  if (idx !== -1) sessions.value[idx].name = updated.name;
}

// ── 拖拽分屏（Task 10）──

function onDragStart(sessionId) { draggingSession.value = sessionId; }
function onDragEnd() { draggingSession.value = null; }

// 落区 drop：side = 0（左）| 1（右）
async function onDrop(side) {
  const sid = draggingSession.value;
  draggingSession.value = null;
  if (!sid) return;
  const existing = panes.value.indexOf(sid);
  if (existing !== -1) {
    if (existing === side) return;     // 拖到已含该会话的一侧：no-op
    panes.value.reverse();             // 已打开标签拖到另一侧：交换
  } else if (panes.value.length === 1) {
    panes.value = side === 0 ? [sid, panes.value[0]] : [panes.value[0], sid];
  } else {
    panes.value[side] = sid;           // 双栏时拖到某侧：替换该侧
  }
  persistPanes();
  await nextTick();
  // 交换场景下两侧 pane 均未卸载且已连接，initPane 内部会跳过
  await initPane(sid);
}

// pane 头 ✕：合并回单栏（被移除的 ChatPane 卸载时自动断 WS）
function onMerge(paneIdx) {
  if (panes.value.length <= 1) return;
  panes.value.splice(paneIdx, 1);
  persistPanes();
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

// 分屏分隔条拖拽（复用面板拖拽模式，范围 0.25 ~ 0.75）
const chatAreaRef = ref(null);
let splitStartX = 0;
let splitStartRatio = 0.5;
let splitAreaWidth = 1;

function startSplitResize(e) {
  splitStartX = e.clientX;
  splitStartRatio = splitRatio.value;
  splitAreaWidth = chatAreaRef.value?.getBoundingClientRect().width || 1;
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onSplitResize);
  document.addEventListener('mouseup', stopSplitResize);
}

function onSplitResize(e) {
  splitRatio.value = Math.min(0.75, Math.max(0.25,
    splitStartRatio + (e.clientX - splitStartX) / splitAreaWidth));
}

function stopSplitResize() {
  document.body.style.userSelect = '';
  document.removeEventListener('mousemove', onSplitResize);
  document.removeEventListener('mouseup', stopSplitResize);
  persistPanes();
}


async function init() {
  try {
    task.value = await http.getTask(props.id);
    sessions.value = task.value.sessions ?? [];
    restorePanes();          // 恢复上次分屏布局（需在 nextTick 前设置 panes）
    await nextTick();
    // 加载历史 + 连接每个打开的 pane
    for (const sid of panes.value) {
      const p = paneRefs.get(sid);
      if (p) { await p.loadHistory(); p.connect(); }
    }
  } catch (e) {
    console.error('加载任务失败:', e);
    router.push('/');
  }
}

onMounted(init);
// WS 断开在 ChatPane 内部 onUnmounted 处理（模板 ref 清空早于父级 onUnmounted，这里拿不到 paneRefs）
onUnmounted(() => {
  stopResize();
  stopSplitResize();
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

    <SessionTabBar
      :sessions="sessions" :panes="panes"
      @select="onSelectSession" @create="onCreateSession"
      @close="onCloseSession" @rename="onRenameSession"
      @dragstart="onDragStart" @dragend="onDragEnd"
    />

    <div class="detail-body">
      <div ref="chatAreaRef" class="chat-area">
        <template v-for="(sid, i) in panes" :key="sid">
          <div v-if="i > 0" class="pane-divider" @mousedown="startSplitResize"></div>
          <ChatPane
            :ref="el => setPaneRef(sid, el)"
            :style="panes.length > 1 ? { flex: i === 0 ? splitRatio : 1 - splitRatio } : {}"
            :task-id="id"
            :session="sessions.find(s => s.id === sid) ?? {}"
            :task="task"
            :split="panes.length > 1"
            @merge="onMerge(i)"
            @done="onPaneDone"
          />
        </template>

        <!-- 拖拽落区（仅拖拽中显示）：左半 / 右半 -->
        <div v-if="draggingSession" class="drop-overlay">
          <div class="dropzone" @dragover.prevent @drop="onDrop(0)">
            <span>⇤ 在左侧打开「{{ sessions.find(s => s.id === draggingSession)?.name }}」</span>
          </div>
          <div class="dropzone" @dragover.prevent @drop="onDrop(1)">
            <span>在右侧打开「{{ sessions.find(s => s.id === draggingSession)?.name }}」⇥</span>
          </div>
        </div>
      </div>

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

/* 聊天区：单/双栏容器，position: relative 供落区绝对定位 */
.chat-area { flex: 1; display: flex; position: relative; overflow: hidden; min-width: 0; }

/* 分屏分隔条：5px col-resize */
.pane-divider { width: 5px; flex-shrink: 0; background: var(--border); cursor: col-resize; }
.pane-divider:hover { background: #3b5bdb; }

/* 拖拽落区：盖住聊天区，左右两个半区 */
.drop-overlay { position: absolute; inset: 0; display: flex; z-index: 20; }
.dropzone {
  flex: 1; margin: 12px; border: 2px dashed var(--accent); border-radius: 14px;
  background: var(--accent-sub);
  display: flex; align-items: center; justify-content: center;
  color: #7b8cde; font-size: 13px; font-weight: 600;
}
.resize-handle {
  width: 6px; flex-shrink: 0; cursor: col-resize;
  background: #2a2a38; transition: background 0.15s;
}
.resize-handle:hover { background: #3b5bdb; }
.loading { display: flex; align-items: center; justify-content: center; height: 100vh; color: #555; }
</style>
