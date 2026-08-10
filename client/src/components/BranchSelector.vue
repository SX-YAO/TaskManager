<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { http } from '../api/http.js';

const props = defineProps({
  modelValue: { type: String, default: 'master' },
  repoPath:   { type: String, default: '' },
  disabled:   { type: Boolean, default: false },
  placeholder:{ type: String, default: '对比分支' },
});
const emit = defineEmits(['update:modelValue']);

// ── 状态 ─────────────────────────────────────────────────────
const isOpen   = ref(false);
const query    = ref('');
const loading  = ref(false);
const branches = ref({ local: [], remote: [] });
const rootRef   = ref(null);
const searchRef = ref(null);
const dropdownRef = ref(null);

// 下拉位置（fixed 定位，脱离 overflow 容器避免被裁剪）
const dropdownPos = ref({ top: '0px', left: '0px' });

function calcPos() {
  if (!rootRef.value) return;
  const rect = rootRef.value.getBoundingClientRect();
  const dropW = 230;
  // 优先右对齐 trigger，不超出视窗左边
  const left = Math.max(4, rect.right - dropW);
  dropdownPos.value = {
    top:  `${rect.bottom + 4}px`,
    left: `${left}px`,
  };
}

// ── 获取分支列表 ───────────────────────────────────────────
async function fetchBranches() {
  if (!props.repoPath) return;
  loading.value = true;
  try {
    branches.value = await http.getBranches(props.repoPath);
  } catch {
    branches.value = { local: [], remote: [] };
  } finally {
    loading.value = false;
  }
}

// repoPath 变化时预加载
watch(() => props.repoPath, (v) => { if (v) fetchBranches(); }, { immediate: true });

// ── 过滤 ─────────────────────────────────────────────────────
const filteredLocal  = computed(() =>
  branches.value.local.filter(b => b.toLowerCase().includes(query.value.toLowerCase()))
);
const filteredRemote = computed(() =>
  branches.value.remote.filter(b => b.toLowerCase().includes(query.value.toLowerCase()))
);

// 对匹配文字加高亮
function highlight(text) {
  if (!query.value) return text;
  const re = new RegExp(`(${query.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(re, '<mark>$1</mark>');
}

// ── 交互 ─────────────────────────────────────────────────────
async function open() {
  if (props.disabled) return;
  calcPos();          // 计算 fixed 坐标，再显示
  isOpen.value = true;
  query.value  = '';
  if (!branches.value.local.length && !branches.value.remote.length) await fetchBranches();
  await nextTick();
  searchRef.value?.focus();
}

function close() {
  isOpen.value = false;
  query.value  = '';
}

function select(branch) {
  emit('update:modelValue', branch);
  close();
}

function onEnter() {
  // Enter 时：优先选中过滤后的第一条，否则用输入值作为自定义分支
  const first = filteredLocal.value[0] ?? filteredRemote.value[0];
  select(first ?? (query.value || props.modelValue));
}

// ── 点击外部关闭（需同时排除 Teleport 出去的下拉面板）──────────
function onClickOutside(e) {
  const inTrigger  = rootRef.value?.contains(e.target);
  const inDropdown = dropdownRef.value?.contains(e.target);
  if (!inTrigger && !inDropdown) close();
}
onMounted(()  => document.addEventListener('mousedown', onClickOutside));
onUnmounted(()=> document.removeEventListener('mousedown', onClickOutside));
</script>

<template>
  <div class="branch-selector-root" ref="rootRef">
    <!-- 触发徽章 -->
    <button
      class="branch-badge"
      :class="{ open: isOpen, disabled }"
      :disabled="disabled"
      @click="isOpen ? close() : open()"
      :title="'对比基准: origin/' + modelValue"
    >
      <span class="b-icon">⎇</span>
      <span class="b-text">{{ modelValue || placeholder }}</span>
      <span class="b-arrow">{{ isOpen ? '▴' : '▾' }}</span>
    </button>

    <!-- 下拉面板：Teleport 到 body 层，用 fixed 定位脱离 overflow 容器 -->
    <Teleport to="body">
      <Transition name="dropdown">
      <div v-if="isOpen" ref="dropdownRef" class="branch-dropdown"
           :style="{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left }"
      >
        <!-- 搜索框 -->
        <div class="branch-search-row">
          <span class="search-icon">⎇</span>
          <input
            ref="searchRef"
            v-model="query"
            class="branch-search"
            placeholder="搜索分支…"
            @keyup.enter="onEnter"
            @keyup.esc="close"
          />
          <span v-if="loading" class="loading-dot">…</span>
        </div>

        <!-- 分支列表 -->
        <div class="branch-list">
          <!-- 无结果 -->
          <div v-if="!loading && !filteredLocal.length && !filteredRemote.length" class="no-result">
            {{ query ? `未找到「${query}」` : '暂无分支' }}
          </div>

          <!-- 本地分支 -->
          <template v-if="filteredLocal.length">
            <div class="branch-group">本地</div>
            <button
              v-for="b in filteredLocal" :key="b"
              class="branch-item"
              :class="{ selected: b === modelValue }"
              @mousedown.prevent="select(b)"
            >
              <span class="check">{{ b === modelValue ? '✓' : '' }}</span>
              <span class="b-name" v-html="highlight(b)"></span>
            </button>
          </template>

          <!-- 远端分支 -->
          <template v-if="filteredRemote.length">
            <div class="branch-group">远端</div>
            <button
              v-for="b in filteredRemote" :key="b"
              class="branch-item"
              :class="{ selected: b === modelValue }"
              @mousedown.prevent="select(b)"
            >
              <span class="check">{{ b === modelValue ? '✓' : '' }}</span>
              <span class="b-name" v-html="highlight(b)"></span>
              <span class="b-remote">remote</span>
            </button>
          </template>
        </div>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.branch-selector-root { position: relative; display: inline-block; }

/* ── 触发徽章：整体限宽，文字超出省略 ── */
.branch-badge {
  display: inline-flex; align-items: center; gap: 3px;
  max-width: 110px;           /* 整体最大宽度 */
  overflow: hidden;           /* 超出隐藏 */
  font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
  background: rgba(59,91,219,.1); color: #7b8cde; cursor: pointer;
  border: 1px solid rgba(59,91,219,.15);
  font-family: "SF Mono", Menlo, monospace; white-space: nowrap;
  transition: background .12s, border-color .12s;
  line-height: 1.4; flex-shrink: 0;
}
.branch-badge:hover:not(.disabled) { background: rgba(59,91,219,.2); border-color: rgba(59,91,219,.3); }
.branch-badge.open { background: rgba(59,91,219,.2); border-color: #3b5bdb; }
.branch-badge.disabled { opacity: .4; cursor: default; }
.b-icon  { font-size: 8px; opacity: .7; flex-shrink: 0; }
/* 文字部分负责截断，icon 和箭头始终可见 */
.b-text  { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b-arrow { font-size: 7px; opacity: .6; flex-shrink: 0; }

/* ── 下拉面板（Teleport 到 body，fixed 定位由 JS 控制）── */
.branch-dropdown {
  z-index: 9999;   /* body 层，高于一切 */
  width: 230px; background: #1a1a24; border: 1px solid #3b5bdb;
  border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
  overflow: hidden;
}

/* 搜索行 */
.branch-search-row {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 10px; border-bottom: 1px solid #1e1e2a;
}
.search-icon { font-size: 11px; color: #555; flex-shrink: 0; }
.branch-search {
  flex: 1; background: transparent; border: none; outline: none;
  font-size: 12px; color: #e8e8f0; font-family: inherit;
}
.branch-search::placeholder { color: #333; }
.loading-dot { font-size: 11px; color: #444; flex-shrink: 0; }

/* 列表区 */
.branch-list { max-height: 200px; overflow-y: auto; padding: 4px 0; }

.branch-group {
  font-size: 9px; font-weight: 700; color: #2a2a40;
  text-transform: uppercase; letter-spacing: .08em;
  padding: 5px 10px 2px;
}

.branch-item {
  display: flex; align-items: center; gap: 7px;
  width: 100%; min-width: 0;   /* flex 截断必要条件 */
  padding: 5px 10px; cursor: pointer; border: none;
  background: transparent; text-align: left; transition: background .1s;
  font-size: 11px; color: #888; font-family: "SF Mono", Menlo, monospace;
}
.branch-item:hover  { background: #1e2030; color: #c8c8d8; }
.branch-item.selected { background: rgba(59,91,219,.1); color: #7b8cde; }
.check { width: 12px; flex-shrink: 0; font-size: 10px; color: #3b5bdb; }
/* 下拉列表：宽度足够多显示内容，超出仍用省略号 */
.b-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b-remote { font-size: 9px; color: #2a2a40; flex-shrink: 0; margin-left: 4px; }

/* 高亮 */
.b-name :deep(mark) {
  background: transparent; color: #7b8cde; font-weight: 700;
}

.no-result { padding: 14px 10px; font-size: 11px; color: #333; text-align: center; }

/* 下拉动画 */
.dropdown-enter-active, .dropdown-leave-active {
  transition: opacity .12s, transform .12s;
}
.dropdown-enter-from, .dropdown-leave-to {
  opacity: 0; transform: translateY(-4px);
}

/* 滚动条 */
.branch-list::-webkit-scrollbar { width: 4px; }
.branch-list::-webkit-scrollbar-thumb { background: #1e1e2a; border-radius: 2px; }
</style>
