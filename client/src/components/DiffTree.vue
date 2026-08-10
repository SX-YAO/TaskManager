<script setup>
import { ref, computed, watch } from 'vue';
import DiffTreeDir  from './DiffTreeDir.vue';
import DiffTreeFile from './DiffTreeFile.vue';

const props = defineProps({
  files:           { type: Array,  default: () => [] },  // { path, absPath, added, deleted, untracked }
  selectedPath:    { type: String, default: '' },
  loading:         { type: Boolean, default: false },
});
const emit = defineEmits(['select-file']);

// ── 搜索 ─────────────────────────────────────────────────────
const query = ref('');

// ── 折叠状态（存目录的 path，在 Set 里 = 折叠）──────────────
const collapsed = ref(new Set());
function toggle(dirPath) {
  const s = new Set(collapsed.value);
  s.has(dirPath) ? s.delete(dirPath) : s.add(dirPath);
  collapsed.value = s;
}
function isCollapsed(dirPath) { return collapsed.value.has(dirPath); }

// ── 构建目录树 ────────────────────────────────────────────────
function buildTree(files) {
  const root = { name: '', path: '', children: new Map(), files: [], added: 0, deleted: 0 };

  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    const dirParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];

    // 创建/导航目录节点
    let accPath = '';
    for (const dir of dirParts) {
      accPath = accPath ? `${accPath}/${dir}` : dir;
      if (!node.children.has(dir)) {
        node.children.set(dir, { name: dir, path: accPath, children: new Map(), files: [], added: 0, deleted: 0 });
      }
      node = node.children.get(dir);
    }
    node.files.push({ ...f, name: fileName });
  }

  // 向上聚合 +/-
  function aggregate(node) {
    let a = 0, d = 0;
    for (const f of node.files) { a += f.added; d += f.deleted; }
    for (const child of node.children.values()) {
      const { added, deleted } = aggregate(child);
      a += added; d += deleted;
    }
    node.added = a; node.deleted = d;
    return { added: a, deleted: d };
  }
  aggregate(root);
  return root;
}

const tree = computed(() => buildTree(props.files));

// ── 搜索过滤：只保留路径包含关键词的文件 ─────────────────────
const filteredPaths = computed(() => {
  if (!query.value) return null;  // null = 不过滤
  const q = query.value.toLowerCase();
  return new Set(props.files.filter(f => f.path.toLowerCase().includes(q)).map(f => f.path));
});

function fileVisible(file) {
  return !filteredPaths.value || filteredPaths.value.has(file.path);
}
function dirVisible(node) {
  if (!filteredPaths.value) return true;
  return hasVisibleFile(node);
}
function hasVisibleFile(node) {
  if (node.files.some(f => filteredPaths.value.has(f.path))) return true;
  for (const child of node.children.values()) {
    if (hasVisibleFile(child)) return true;
  }
  return false;
}

// 搜索时自动展开所有目录
watch(query, (q) => {
  if (q) collapsed.value = new Set();
});

// ── 文件状态 ─────────────────────────────────────────────────
function fileStatus(f) {
  if (f.untracked) return 'A';
  if (f.deleted > 0 && f.added === 0) return 'D';
  return 'M';
}

// ── 扩展名徽章 ───────────────────────────────────────────────
const EXT_CLASS = {
  ts: 'ext-ts', tsx: 'ext-ts',
  js: 'ext-js', jsx: 'ext-js', mjs: 'ext-js', cjs: 'ext-js',
  vue: 'ext-vue',
  html: 'ext-html',
  css: 'ext-css', scss: 'ext-css', less: 'ext-css',
  json: 'ext-json',
  md: 'ext-md',
  py: 'ext-py',
  java: 'ext-java',
  go: 'ext-go',
};
function extClass(name) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_CLASS[ext] ?? 'ext-other';
}
function extLabel(name) {
  return (name.split('.').pop() ?? '').toLowerCase().slice(0, 4);
}

// ── 高亮搜索词 ───────────────────────────────────────────────
function highlight(text) {
  if (!query.value) return text;
  const re = new RegExp(`(${query.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(re, '<mark>$1</mark>');
}

// ── 目录树排序：目录优先，再按名称 ───────────────────────────
function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function sortedFiles(node) {
  return [...node.files].sort((a, b) => a.name.localeCompare(b.name));
}
</script>

<template>
  <div class="diff-tree">
    <!-- 搜索框 -->
    <div class="tree-search-wrap">
      <span class="search-icon">🔍</span>
      <input
        v-model="query"
        class="tree-search"
        placeholder="过滤文件…"
      />
      <span v-if="query" class="search-clear" @click="query = ''">✕</span>
    </div>

    <!-- 文件总数 -->
    <div class="tree-summary">
      {{ files.length }} 文件
      <span class="stat-a">+{{ files.reduce((s,f)=>s+f.added,0) }}</span>
      <span class="stat-d" v-if="files.reduce((s,f)=>s+f.deleted,0)">
        -{{ files.reduce((s,f)=>s+f.deleted,0) }}
      </span>
    </div>

    <!-- 目录树 -->
    <div class="tree-scroll">
      <div v-if="loading" class="tree-empty">加载中…</div>
      <div v-else-if="!files.length" class="tree-empty">暂无改动</div>
      <template v-else>
        <DiffTreeDir
          v-for="child in sortedChildren(tree)"
          :key="child.path"
          :node="child"
          :depth="0"
          :collapsed-set="collapsed"
          :selected-path="selectedPath"
          :filter-paths="filteredPaths"
          :query="query"
          @toggle="toggle"
          @select="emit('select-file', $event)"
        />
        <DiffTreeFile
          v-for="f in sortedFiles(tree)"
          :key="f.path"
          :file="f"
          :depth="0"
          :is-selected="f.path === selectedPath"
          :query="query"
          v-show="fileVisible(f)"
          @select="emit('select-file', $event)"
        />
      </template>
    </div>
  </div>
</template>

<!-- 递归子组件：目录节点 -->
<script>
// Vue 3 支持在同一文件定义多个组件（非 setup 方式）
</script>

<style scoped>
.diff-tree {
  width: 220px; flex-shrink: 0;                        /* 固定侧栏宽度 */
  display: flex; flex-direction: column; height: 100%; overflow: hidden;
  background: var(--bg-surface-3);
  border-right: 1px solid var(--border-sub);
}

/* 搜索 */
.tree-search-wrap {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
}
.search-icon { font-size: 11px; color: var(--text-dim); flex-shrink: 0; }
.tree-search {
  flex: 1; background: transparent; border: none; outline: none;
  font-size: 12px; color: var(--text-primary);
}
.tree-search::placeholder { color: var(--text-dim); }
.search-clear {
  font-size: 10px; color: var(--text-dim); cursor: pointer; padding: 1px 4px;
  border-radius: 3px; transition: color .12s;
}
.search-clear:hover { color: var(--text-muted); }

/* 汇总行 */
.tree-summary {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; font-size: 10px; color: var(--text-dim);
  border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
}
.stat-a { color: #40c057; font-weight: 700; }
.stat-d { color: #e03131; font-weight: 700; }

/* 滚动区 */
.tree-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 0; }
.tree-empty { padding: 20px 12px; font-size: 12px; color: var(--text-dim); text-align: center; }
</style>
