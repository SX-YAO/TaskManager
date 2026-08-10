<script setup>
const props = defineProps({
  file:       { type: Object,  required: true },
  depth:      { type: Number,  default: 0 },
  isSelected: { type: Boolean, default: false },
  query:      { type: String,  default: '' },
});
const emit = defineEmits(['select']);

const EXT_CLASS = {
  ts:'ext-ts',tsx:'ext-ts',js:'ext-js',jsx:'ext-js',mjs:'ext-js',cjs:'ext-js',
  vue:'ext-vue',html:'ext-html',css:'ext-css',scss:'ext-css',less:'ext-css',
  json:'ext-json',md:'ext-md',py:'ext-py',java:'ext-java',go:'ext-go',
  sh:'ext-sh',yaml:'ext-json',yml:'ext-json',
};

function extClass(name) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_CLASS[ext] ?? 'ext-other';
}
function extLabel(name) {
  return (name.split('.').pop() ?? '').toLowerCase().slice(0, 4);
}
function fileStatus(f) {
  if (f.untracked) return 'A';
  if (f.deleted > 0 && f.added === 0) return 'D';
  return 'M';
}
function highlight(text) {
  if (!props.query) return text;
  const re = new RegExp(`(${props.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(re, '<mark>$1</mark>');
}
</script>

<template>
  <div
    class="file-row"
    :class="{ active: isSelected }"
    :style="{ paddingLeft: `${10 + depth * 14}px` }"
    @click="emit('select', file)"
  >
    <!-- 状态点 -->
    <span class="status-dot" :class="`dot-${fileStatus(file)}`"></span>

    <!-- 扩展名徽章 -->
    <span class="ext-badge" :class="extClass(file.name)">{{ extLabel(file.name) }}</span>

    <!-- 文件名 -->
    <span
      class="node-label file-label"
      :class="`label-${fileStatus(file)}`"
      v-html="highlight(file.name)"
    ></span>

    <!-- 行数统计 -->
    <span class="node-stats">
      <span v-if="file.added"   class="stat-a">+{{ file.added }}</span>
      <span v-if="file.deleted" class="stat-d">-{{ file.deleted }}</span>
    </span>
  </div>
</template>

<style scoped>
.file-row {
  display: flex; align-items: center; height: 26px;
  padding-right: 8px; cursor: pointer; gap: 4px;
  transition: background .08s;
}
.file-row:hover  { background: var(--bg-hover); }
.file-row.active { background: rgba(59,91,219,.12); border-left: 2px solid #3b5bdb; }

.status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.dot-A { background: #40c057; }
.dot-M { background: #f59f00; }
.dot-D { background: #e03131; }

.ext-badge {
  font-size: 8px; font-weight: 800; padding: 1px 3px;
  border-radius: 2px; flex-shrink: 0; letter-spacing: -.3px;
}
.ext-ts   { background: rgba(29,78,216,.12);  color: #1d4ed8; }
.ext-js   { background: rgba(146,64,14,.1);   color: #854d0e; }
.ext-vue  { background: rgba(64,192,87,.12);  color: #15803d; }
.ext-html { background: rgba(185,28,28,.1);   color: #b91c1c; }
.ext-css  { background: rgba(157,23,77,.1);   color: #9d174d; }
.ext-json { background: rgba(22,101,52,.1);   color: #166534; }
.ext-md   { background: rgba(91,33,182,.1);   color: #5b21b6; }
.ext-py   { background: rgba(2,132,199,.1);   color: #0369a1; }
.ext-java { background: rgba(194,65,12,.1);   color: #c2410c; }
.ext-go   { background: rgba(8,145,178,.1);   color: #0891b2; }
.ext-sh   { background: rgba(75,85,99,.1);    color: #374151; }
.ext-other{ background: rgba(107,114,128,.1); color: #6b7280; }

.node-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.file-label { color: var(--text-secondary); }
.label-A { color: #15803d; }
.label-D { color: #b91c1c; text-decoration: line-through; opacity: .7; }

.node-stats { font-size: 10px; flex-shrink: 0; display: flex; gap: 4px; }
.stat-a { color: #16a34a; font-weight: 700; }
.stat-d { color: #dc2626; font-weight: 700; }

/* 高亮搜索 */
:deep(mark) { background: rgba(234,179,8,.35); border-radius: 2px; color: inherit; }
</style>
