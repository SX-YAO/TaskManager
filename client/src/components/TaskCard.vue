<script setup>
import { computed } from 'vue';
import Popover from './Popover.vue';

const props = defineProps({
  task: { type: Object, required: true },
});
defineEmits(['delete']);

// 会话角标统计：running 数与总会话数（兼容无 sessions 的旧数据）
const sessionStats = computed(() => {
  const ss = props.task.sessions ?? [];
  const running = ss.filter(s => s.status === 'running').length;
  return { total: ss.length, running };
});

const STATUS = {
  idle:      { label: '未运行',   color: '#444',    dot: '#333' },
  running:   { label: '处理中',   color: '#40c057', dot: '#40c057' },
  pending:   { label: '待确认',   color: '#f59f00', dot: '#f59f00' },
  reviewing: { label: '验收中',   color: '#3b82f6', dot: '#3b82f6' },
  error:     { label: '异常',     color: '#e03131', dot: '#e03131' },
  archived:  { label: '已归档',   color: '#555',    dot: '#333' },
  // 旧状态兼容（服务器迁移后不再产生）
  paused:       { label: '空闲待续', color: '#4dabf7', dot: '#339af0' },
  interrupted:  { label: '已中断',   color: '#c17700', dot: '#fab005' },
};

// 只取路径最后一段目录名，不展示完整路径
function dirName(p) {
  if (!p) return '';
  return p.replace(/\/+$/, '').split('/').pop() ?? p;
}

function firstLine(text) {
  if (!text) return '';
  const line = text.split('\n').find(l => l.trim()) ?? '';
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
</script>

<template>
  <div class="card" :class="task.status">
    <div class="card-stripe"></div>

    <div class="card-top">
      <Popover :content="task.title" :max-width="240">
        <div class="card-title">{{ task.title }}</div>
      </Popover>

        <!-- 右上角状态标识：不同状态用不同图标 -->
      <div class="card-action">
        <div class="status-badge" :class="[task.status, { pulse: task.status === 'running' }]">
          <span v-if="task.status === 'running'">●</span>
          <span v-else-if="task.status === 'pending'">🔔</span>
          <span v-else-if="task.status === 'reviewing'">◎</span>
          <span v-else-if="task.status === 'error'">!</span>
          <span v-else>○</span>
        </div>
        <button class="btn-delete" title="删除任务" @click.stop="$emit('delete', task)">✕</button>
      </div>
    </div>

    <!-- card-status：running 状态加呼吸动效 -->
    <div
      class="card-status"
      :class="{ pulse: task.status === 'running' }"
      :style="{ color: STATUS[task.status]?.color }"
    >
      {{ task.status === 'running' ? '●' : task.status === 'pending' ? '◉' : task.status === 'reviewing' ? '◎' : task.status === 'error' ? '✕' : '○' }}
      {{ STATUS[task.status]?.label ?? task.status }}
    </div>

    <!-- 任务目的 -->
    <div v-if="task.purpose" class="card-purpose">{{ firstLine(task.purpose) }}</div>

    <div class="card-meta">
      <span>📁 {{ dirName(task.projectDir) }}</span>
      <span>🤖 {{ task.agentType }}</span>
      <span>🕐 {{ fmtTime(task.createdAt) }}</span>
    </div>

    <!-- 会话角标：有运行中会话或多会话时显示 -->
    <div class="card-sessions">
      <span v-if="sessionStats.running" class="sess-badge running">● {{ sessionStats.running }} 运行中</span>
      <span v-if="sessionStats.total > 1" class="sess-badge total">{{ sessionStats.total }} 会话</span>
    </div>

    <!-- 底部提示区：有提示时显示内容，无提示时占位保持高度一致 -->
    <div class="card-note-area">
      <div v-if="task.status === 'pending'" class="pending-note">需要你的确认才能继续</div>
      <div v-else-if="task.status === 'error'" class="error-note">进程异常，发消息可重试</div>
      <!-- 无提示时空白占位，与 note 高度相同 -->
      <div v-else class="note-placeholder"></div>
    </div>
  </div>
</template>

<style scoped>
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.1s;
}
.card:hover { border-color: #3a3a4e; transform: translateY(-1px); }

.card-stripe { position: absolute; top: 0; left: 0; right: 0; height: 3px; }
.card.running     .card-stripe { background: #40c057; }
.card.pending     .card-stripe { background: #f59f00; }
.card.reviewing   .card-stripe { background: #3b82f6; }
.card.error       .card-stripe { background: #e03131; }
.card.idle        .card-stripe { background: #2a2a38; }
.card.archived    .card-stripe { background: #2a2a38; }
/* 旧状态兼容 */
.card.interrupted .card-stripe { background: #fab005; }
.card.paused      .card-stripe { background: #339af0; }

/* pending：橙色边框微高亮 */
.card.pending { border-color: rgba(245,159,0,.28); background: #1c1a17; }
.card.pending:hover { border-color: rgba(245,159,0,.45); }

/* error：红色边框微高亮 */
.card.error   { border-color: rgba(224,49,49,.22); background: #1c1717; }
.card.error:hover { border-color: rgba(224,49,49,.38); }

.card-top {
  display: flex; align-items: flex-start;
  justify-content: space-between; margin-bottom: 8px;
}
.card-title {
  font-size: 14px; font-weight: 600; color: var(--text-primary);
  line-height: 1.4; flex: 1; margin-right: 10px;
  /* 超长标题截断，Popover 悬停查看完整内容 */
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* 共用容器：固定 20×20，dot 和 btn-delete 叠在一起 */
.card-action {
  position: relative;
  width: 20px; height: 20px;
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}

/* ── 右上角状态标识（替换原 dot）── */
.status-badge {
  position: absolute;
  width: 20px; height: 20px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
  transition: opacity 0.18s, transform 0.18s;
}
/* 各状态颜色 */
.status-badge.idle      { background: #1e1e2a; color: #444; font-size: 9px; }
.status-badge.running   { background: rgba(64,192,87,.15); color: #40c057; }
.status-badge.pending   { background: rgba(245,159,0,.15); color: #f59f00; font-size: 13px; }
.status-badge.reviewing { background: rgba(59,130,246,.15); color: #3b82f6; font-size: 9px; }
.status-badge.error     { background: rgba(224,49,49,.15); color: #e03131; font-size: 12px; font-weight: 900; }
.status-badge.paused    { background: rgba(51,154,240,.12); color: #4dabf7; font-size: 9px; }

.btn-delete {
  position: absolute; inset: 0;
  background: transparent; border: none;
  border-radius: 5px; color: #555; font-size: 10px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  opacity: 0; transform: scale(0.6);
  transition: opacity 0.18s, transform 0.18s, color 0.12s, background 0.12s;
}

/* 悬停时：status-badge 消失，删除按钮浮现 */
.card:hover .status-badge { opacity: 0; transform: scale(0.4); }
.card:hover .btn-delete   { opacity: 1; transform: scale(1); }
.btn-delete:hover { color: #e03131; background: rgba(224,49,49,0.1); border-radius: 5px; }

/* ── 呼吸动效（running 状态）── */
@keyframes breathe {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}
.pulse { animation: breathe 1.8s ease-in-out infinite; }

.card-status { font-size: 11px; font-weight: 500; margin-bottom: 6px; }

.card-purpose {
  font-size: 11px; color: #44445a; line-height: 1.4;
  margin-bottom: 10px;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-meta { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.card-meta span { display: flex; align-items: center; gap: 6px; }

/* ── 会话角标 ── */
.card-sessions { display: flex; gap: 6px; margin-top: 8px; }
.sess-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.sess-badge.running { background: rgba(64,192,87,.1); color: #40c057; }
.sess-badge.total   { background: rgba(59,91,219,.12); color: #7b8cde; }

/* ── 底部提示区：note 或空白占位，保持高度一致 ── */
.card-note-area { margin-top: 8px; }

.note-placeholder {
  /* 与 pending-note/error-note 同高：padding(5+5) + line-height(1.4*11≈15) + border(2) ≈ 27px */
  height: 27px;
}

.pending-note {
  padding: 5px 9px;
  background: rgba(245,159,0,.07); border: 1px solid rgba(245,159,0,.2);
  border-radius: 6px; font-size: 11px; color: #a07020; line-height: 1.4;
}
.error-note {
  padding: 5px 9px;
  background: rgba(224,49,49,.07); border: 1px solid rgba(224,49,49,.18);
  border-radius: 6px; font-size: 11px; color: #903030; line-height: 1.4;
}
</style>
