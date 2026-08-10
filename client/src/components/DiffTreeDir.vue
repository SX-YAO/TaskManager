<script setup>
import DiffTreeFile from './DiffTreeFile.vue';
// 递归引用自身
import DiffTreeDir  from './DiffTreeDir.vue';

const props = defineProps({
  node:         { type: Object,  required: true },
  depth:        { type: Number,  default: 0 },
  collapsedSet: { type: Object,  required: true },   // Set
  selectedPath: { type: String,  default: '' },
  filterPaths:  { type: Object,  default: null },    // Set | null
  query:        { type: String,  default: '' },
});
const emit = defineEmits(['toggle', 'select']);

const isCollapsed = (path) => props.collapsedSet.has(path);

function fileVisible(file) {
  return !props.filterPaths || props.filterPaths.has(file.path);
}
function dirVisible(node) {
  if (!props.filterPaths) return true;
  return hasVisible(node);
}
function hasVisible(node) {
  if (node.files.some(f => props.filterPaths.has(f.path))) return true;
  for (const child of node.children.values()) {
    if (hasVisible(child)) return true;
  }
  return false;
}

function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function sortedFiles(node) {
  return [...node.files].sort((a, b) => a.name.localeCompare(b.name));
}

function highlight(text) {
  if (!props.query) return text;
  const re = new RegExp(`(${props.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(re, '<mark>$1</mark>');
}
</script>

<template>
  <div class="dir-node" v-if="dirVisible(node)">
    <!-- 目录行 -->
    <div
      class="dir-row"
      :style="{ paddingLeft: `${10 + depth * 14}px` }"
      @click="emit('toggle', node.path)"
    >
      <span class="expand-icon" :class="{ open: !isCollapsed(node.path) }">›</span>
      <span class="dir-icon">📁</span>
      <span class="node-label dir-label" v-html="highlight(node.name)"></span>
      <span class="node-stats">
        <span v-if="node.added"   class="stat-a">+{{ node.added }}</span>
        <span v-if="node.deleted" class="stat-d">-{{ node.deleted }}</span>
      </span>
    </div>

    <!-- 子节点（可折叠） -->
    <div v-show="!isCollapsed(node.path)" class="dir-children">
      <!-- 子目录（递归） -->
      <DiffTreeDir
        v-for="child in sortedChildren(node)"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :collapsed-set="collapsedSet"
        :selected-path="selectedPath"
        :filter-paths="filterPaths"
        :query="query"
        @toggle="emit('toggle', $event)"
        @select="emit('select', $event)"
      />
      <!-- 文件 -->
      <DiffTreeFile
        v-for="f in sortedFiles(node)"
        :key="f.path"
        :file="f"
        :depth="depth + 1"
        :is-selected="f.path === selectedPath"
        :query="query"
        v-show="fileVisible(f)"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.dir-row {
  display: flex; align-items: center; height: 28px;
  padding-right: 8px; cursor: pointer; gap: 4px;
  transition: background .08s;
}
.dir-row:hover { background: var(--bg-hover); }

.expand-icon {
  width: 14px; height: 14px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--text-dim); transition: transform .15s;
}
.expand-icon.open { transform: rotate(90deg); }

.dir-icon { font-size: 13px; flex-shrink: 0; }

.node-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dir-label  { color: var(--text-primary); font-weight: 500; }

.node-stats { font-size: 10px; flex-shrink: 0; display: flex; gap: 4px; }
.stat-a { color: #16a34a; font-weight: 700; }
.stat-d { color: #dc2626; font-weight: 700; }

:deep(mark) { background: rgba(234,179,8,.35); border-radius: 2px; color: inherit; }
</style>
