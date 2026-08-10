<script setup>
import { ref, watch, onUnmounted } from 'vue';

const props = defineProps({
  sessions: { type: Array, required: true },
  panes:    { type: Array, required: true },   // 打开的 sessionId（高亮用）
});
const emit = defineEmits(['select', 'create', 'close', 'rename', 'dragstart', 'dragend']);

// 局部指令：挂载即聚焦（改名输入框 / 新建输入框）
const vFocus = { mounted: el => el.focus() };

const showNew   = ref(false);
const newName   = ref('');
const editingId = ref(null);
const editName  = ref('');

function submitNew() {
  emit('create', newName.value.trim() || undefined);
  newName.value = ''; showNew.value = false;
}

function startRename(s) {
  if (s.status === 'closed') return;   // closed 标签不可改名
  editingId.value = s.id; editName.value = s.name;
}

function submitRename() {
  if (editName.value.trim() && editingId.value) emit('rename', editingId.value, editName.value.trim());
  editingId.value = null;
}

function onClose(s) {
  if (s.isMain) return;   // 主会话不可关闭（模板里也不渲染 ×，双保险）
  if (confirm(`关闭会话「${s.name}」？\n关闭后将冻结，仅供回看，不可再发消息。`)) emit('close', s.id);
}

// 点击弹层外部时关闭新建弹层
function onDocClick() { showNew.value = false; }
watch(showNew, v => {
  if (v) document.addEventListener('click', onDocClick);
  else   document.removeEventListener('click', onDocClick);
});
onUnmounted(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div class="tabbar">
    <div
      v-for="s in sessions" :key="s.id"
      class="stab"
      :class="{ active: panes.includes(s.id), 'closed-tab': s.status === 'closed' }"
      draggable="true"
      @click="emit('select', s.id)"
      @dblclick="startRename(s)"
      @dragstart="emit('dragstart', s.id)"
      @dragend="emit('dragend')"
    >
      <span class="dot" :class="s.status"></span>
      <input
        v-if="editingId === s.id"
        v-model="editName" class="rename-input"
        @blur="submitRename" @keydown.enter="submitRename" @keydown.esc="editingId = null"
        @click.stop @dblclick.stop v-focus
      />
      <template v-else>
        <span class="name">{{ s.name }}</span>
        <span v-if="s.isMain" class="main-tag">主</span>
        <span v-else-if="s.status !== 'closed'" class="close-x" title="关闭会话" @click.stop="onClose(s)">✕</span>
      </template>
    </div>

    <div class="new-wrap" @click.stop>
      <div class="stab new-btn" @click="showNew = !showNew">＋ 新会话</div>
      <div v-if="showNew" class="new-popover">
        <div class="p-title">新建会话</div>
        <input v-model="newName" class="p-input" placeholder="名称（可选，如 方案B）"
               @keydown.enter="submitNew" @keydown.esc="showNew = false" v-focus />
        <div class="p-hint">名称可选，留空默认命名。新会话共享任务目标 / 进度 / 产出，拥有独立对话上下文。</div>
        <div class="p-actions">
          <button class="p-btn ghost" @click="showNew = false">取消</button>
          <button class="p-btn primary" @click="submitNew">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tabbar {
  background: var(--bg-surface-2); border-bottom: 1px solid var(--border);
  padding: 0 12px; height: 40px; flex-shrink: 0;
  display: flex; align-items: flex-end; gap: 4px;
}
.stab {
  display: flex; align-items: center; gap: 7px;
  padding: 0 14px; height: 33px;
  border: 1px solid transparent; border-bottom: none;
  border-radius: 8px 8px 0 0;
  font-size: 12px; color: var(--text-muted);
  cursor: pointer; position: relative; user-select: none;
}
.stab.active {
  background: var(--bg-base); border-color: var(--border);
  color: var(--text-primary); font-weight: 600;
  margin-bottom: -1px; height: 34px;
}

/* 状态点：颜色与 ChatPane pane-head 保持一致 */
.dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: #3a3a4e; }
.dot.running   { background: #40c057; box-shadow: 0 0 5px rgba(64,192,87,.5); }
.dot.pending   { background: #f59f00; }
.dot.reviewing { background: #4090e0; }
.dot.idle      { background: #3a3a4e; }
.dot.closed    { background: transparent; border: 1px solid #33334a; }

/* closed 标签：灰显 + 删除线，仍可点开回看 */
.stab.closed-tab { color: #3d3d55; }
.stab.closed-tab .name { text-decoration: line-through; text-decoration-color: #33334a; }

.main-tag {
  font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px;
  background: var(--accent-sub); color: #7b8cde; letter-spacing: .03em;
}
.close-x {
  width: 15px; height: 15px; border-radius: 4px; font-size: 10px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted);
}
.close-x:hover { background: rgba(224,49,49,.15); color: #e03131; }

.rename-input {
  background: var(--bg-input); border: 1px solid var(--accent);
  border-radius: 5px; padding: 2px 6px; font-size: 12px;
  color: var(--text-primary); outline: none; width: 120px;
}

.new-wrap { position: relative; display: flex; align-items: flex-end; }
.stab.new-btn { color: #4a4a66; font-size: 12px; gap: 5px; }
.stab.new-btn:hover { color: #7b8cde; }

/* 新建会话弹层 */
.new-popover {
  position: absolute; top: 40px; left: 0; z-index: 10;
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px; width: 240px;
  box-shadow: 0 16px 48px rgba(0,0,0,.6);
}
.p-title { font-size: 12px; font-weight: 700; margin-bottom: 8px; }
.p-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-input); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; font-size: 12px;
  color: var(--text-secondary); outline: none;
}
.p-input:focus { border-color: var(--accent); }
.p-hint { font-size: 10px; color: var(--text-muted); margin-top: 7px; line-height: 1.6; }
.p-actions { display: flex; gap: 8px; margin-top: 10px; }
.p-btn {
  flex: 1; font-size: 11px; font-weight: 600;
  padding: 6px 0; border-radius: 7px; border: none; cursor: pointer;
}
.p-btn.primary { background: var(--accent); color: #fff; }
.p-btn.primary:hover { background: var(--accent-hover); }
.p-btn.ghost { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
</style>
