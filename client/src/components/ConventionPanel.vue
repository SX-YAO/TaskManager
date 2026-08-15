<script setup>
import { ref, onMounted } from 'vue';
import { http } from '../api/http.js';

const props = defineProps({
  taskId: { type: String, required: true },
});

const scope   = ref('task');          // 'task' | 'global'
const taskList   = ref([]);
const globalList = ref([]);
const editingId  = ref(null);
const editText   = ref('');
const newText    = ref('');
const stats      = ref(null);

const ORIGIN_LABEL = { distill: '蒸馏', human: '人工', agent: 'agent 上报', retro: '复盘沉淀' };

async function load() {
  try {
    [taskList.value, globalList.value, stats.value] = await Promise.all([
      http.getConventions(props.taskId),
      http.getGlobalConventions(),
      http.getMetricsSummary(),
    ]);
  } catch (e) { console.error('加载规范失败', e); }
}

function startEdit(e) { editingId.value = e.id; editText.value = e.text; }
function cancelEdit() { editingId.value = null; }

async function saveEdit(e) {
  if (!editText.value.trim()) return;
  try {
    if (scope.value === 'task') await http.updateConvention(props.taskId, e.id, editText.value.trim());
    else await http.updateGlobalConvention(e.id, editText.value.trim());
    editingId.value = null;
    await load();
  } catch (err) { console.error('保存失败', err); }
}

async function add() {
  if (!newText.value.trim()) return;
  try {
    if (scope.value === 'task') await http.addConvention(props.taskId, newText.value.trim());
    else await http.addGlobalConvention(newText.value.trim());
    newText.value = '';
    await load();
  } catch (e) { console.error('新增失败', e); }
}

async function remove(e) {
  try {
    if (scope.value === 'task') await http.deleteConvention(props.taskId, e.id);
    else await http.deleteGlobalConvention(e.id);
    await load();
  } catch (err) { console.error('删除失败', err); }
}

async function promote(e) { try { await http.promoteConvention(props.taskId, e.id); await load(); } catch (err) { console.error(err); } }
async function demote(e)  { try { await http.demoteGlobalConvention(e.id, props.taskId); await load(); } catch (err) { console.error(err); } }
async function confirm(e) { try { await http.confirmGlobalConvention(e.id); await load(); } catch (err) { console.error(err); } }

function fmtRate(x) { return `${Math.round((x ?? 0) * 100)}%`; }

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="conv-panel">
    <div class="conv-head">
      <div class="scope-switch">
        <span class="scope-opt" :class="{ on: scope === 'task' }" @click="scope = 'task'">本任务 {{ taskList.length }}</span>
        <span class="scope-opt" :class="{ on: scope === 'global' }" @click="scope = 'global'">全局 {{ globalList.length }}</span>
      </div>
    </div>

    <div class="conv-add">
      <input v-model="newText" class="add-input" placeholder="新增规范，回车确认" @keyup.enter="add" />
    </div>

    <div class="conv-list">
      <div v-for="e in (scope === 'task' ? taskList : globalList)" :key="e.id"
           class="conv-item" :class="{ candidate: e.candidate, editing: editingId === e.id }">
        <template v-if="editingId === e.id">
          <textarea v-model="editText" class="edit-area" rows="2"></textarea>
          <div class="edit-actions">
            <button class="btn-cancel" @click="cancelEdit">取消</button>
            <button class="btn-save" @click="saveEdit(e)">保存</button>
          </div>
        </template>
        <template v-else>
          <div class="conv-text">{{ e.text }}</div>
          <div class="conv-meta">
            <span v-if="e.candidate" class="chip cand">◆ 候选</span>
            <span class="chip" :class="`origin-${e.origin}`">{{ ORIGIN_LABEL[e.origin] ?? e.origin }}</span>
            <span class="chip hits">hits {{ e.hits }}</span>
            <span v-if="e.sources?.length > 1" class="chip">来源 {{ e.sources.length }} 任务</span>
            <span class="conv-actions">
              <button v-if="scope === 'task'" class="mini-btn promote" @click="promote(e)">↑ 提升全局</button>
              <button v-if="scope === 'global' && e.candidate" class="mini-btn promote" @click="confirm(e)">✓ 确认</button>
              <button v-if="scope === 'global'" class="mini-btn demote" @click="demote(e)">↓ 降级</button>
              <button class="mini-btn" @click="startEdit(e)">编辑</button>
              <button class="mini-btn del" @click="remove(e)">删</button>
            </span>
          </div>
        </template>
      </div>
      <div v-if="!(scope === 'task' ? taskList : globalList).length" class="empty-hint">暂无规范</div>
    </div>

    <div v-if="stats" class="stats-block">
      <div class="stats-title">近 7 天 · 体系运行统计</div>
      <div class="stats-grid">
        <div class="stat"><b>{{ fmtRate(stats.toolCall.okRate) }}</b><span>工具调用成功率</span></div>
        <div class="stat warn"><b>{{ fmtRate(stats.editRate) }}</b><span>蒸馏条目人工编辑率</span></div>
        <div class="stat"><b>{{ stats.distill.promoted }}</b><span>晋升全局</span></div>
        <div class="stat"><b>{{ stats.digest.avgBytes }}B</b><span>digest 平均体积</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.conv-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; font-size: 12px; }
.conv-head { padding: 10px 12px 6px; }
.scope-switch { display: inline-flex; background: var(--bg-surface-3); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.scope-opt { font-size: 11px; padding: 5px 12px; color: var(--text-muted); cursor: pointer; }
.scope-opt.on { background: rgba(59,91,219,.2); color: #8fa1e8; }
.conv-add { padding: 0 12px 8px; }
.add-input { width: 100%; background: var(--bg-surface-3); border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; font-size: 12px; color: var(--text-primary); outline: none; }
.add-input:focus { border-color: var(--accent); }
.conv-list { flex: 1; overflow-y: auto; padding: 0 12px 10px; display: flex; flex-direction: column; gap: 8px; }
.conv-item { background: var(--bg-surface-3); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.conv-item.candidate { border-color: rgba(247,176,55,.35); }
.conv-item.editing { border-color: var(--accent); }
.conv-text { font-size: 12.5px; line-height: 1.55; color: var(--text-primary); }
.conv-meta { display: flex; align-items: center; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
.chip { font-size: 10px; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--border); color: var(--text-muted); }
.chip.cand { color: #f7b037; border-color: rgba(247,176,55,.4); background: rgba(247,176,55,.08); }
.chip.origin-distill { color: #8fa1e8; } .chip.origin-human { color: #63e6be; }
.chip.origin-agent { color: #b197fc; } .chip.origin-retro { color: #ffa94d; }
.conv-actions { margin-left: auto; display: flex; gap: 4px; }
.mini-btn { font-size: 10.5px; color: var(--text-muted); background: none; border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.mini-btn.promote { color: #63e6be; border-color: rgba(99,230,190,.3); }
.mini-btn.demote { color: #f7b037; border-color: rgba(247,176,55,.3); }
.mini-btn.del { color: #e03131; border-color: rgba(224,49,49,.25); }
.edit-area { width: 100%; background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 12.5px; padding: 8px 10px; resize: vertical; }
.edit-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 7px; }
.btn-save { font-size: 11px; background: var(--accent); color: #fff; border: none; border-radius: 7px; padding: 4px 14px; cursor: pointer; }
.btn-cancel { font-size: 11px; color: var(--text-muted); background: none; border: 1px solid var(--border); border-radius: 7px; padding: 4px 12px; cursor: pointer; }
.empty-hint { color: var(--text-dim); font-style: italic; padding: 8px 2px; }
.stats-block { border-top: 1px solid var(--border); padding: 10px 14px; }
.stats-title { font-size: 11px; color: var(--text-dim); margin-bottom: 8px; }
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.stat { background: var(--bg-surface-3); border: 1px solid var(--border); border-radius: 8px; padding: 8px 4px; text-align: center; }
.stat b { display: block; font-size: 15px; color: #8fa1e8; }
.stat.warn b { color: #f7b037; }
.stat span { font-size: 10px; color: var(--text-muted); }
</style>
