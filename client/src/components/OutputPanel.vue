<script setup>
import { ref, computed, watch, onMounted, nextTick, onUnmounted } from 'vue';
import { http } from '../api/http.js';
import DiffTree from './DiffTree.vue';
import Popover  from './Popover.vue';

const props = defineProps({
  taskId:          { type: String, required: true },
  task:            { type: Object, default: null },            // 完整 task meta（含 watchedRepos）
  refreshTrigger:  { type: Number, default: 0 },
  initialTab:      { type: String, default: 'diff' },
  initialArtifact: { type: Object, default: null },
  initialDiffFile: { type: String, default: '' },
});
const emit = defineEmits(['close']);

// ── 仓库列表（从 task.watchedRepos 派生）────────────────────
const repos = computed(() => {
  const raw = props.task?.watchedRepos;
  if (raw?.length) return raw;
  const pd = props.task?.projectDir;
  return pd ? [{ path: pd.replace(/\/+$/, ''), baseBranch: 'master' }] : [];
});

function repoName(r) { return (r?.path ?? '').replace(/\/+$/, '').split('/').pop(); }

// ── 控制栏状态 ────────────────────────────────────────────
const selectedRepoIdx  = ref(0);
// 三种模式：branch（当前分支 vs 目标分支，默认）| uncommitted（未提交内容）| commit（单次 commit）
const scopeMode        = ref('branch');
const selectedCommit   = ref(null);            // { hash, message, relTime }

const selectedRepo = computed(() => repos.value[selectedRepoIdx.value] ?? repos.value[0] ?? null);

// ── 下拉开关 ──────────────────────────────────────────────
const repoDropOpen  = ref(false);
const scopeDropOpen = ref(false);
const repoDropEl    = ref(null);
const scopeDropEl   = ref(null);
const repoBtnEl     = ref(null);
const scopeBtnEl    = ref(null);
const repoDropPos   = ref({ top: '0px', left: '0px' });
const scopeDropPos  = ref({ top: '0px', left: '0px' });

function openRepoDrop() {
  scopeDropOpen.value = false;
  repoDropOpen.value  = !repoDropOpen.value;
  if (repoDropOpen.value) nextTick(() => calcDropPos(repoBtnEl, repoDropPos));
}
function openScopeDrop() {
  repoDropOpen.value  = false;
  scopeDropOpen.value = !scopeDropOpen.value;
  if (scopeDropOpen.value) {
    nextTick(() => calcDropPos(scopeBtnEl, scopeDropPos));
    loadCommitsIfNeeded();
  }
}
function calcDropPos(btnRef, posRef) {
  if (!btnRef.value) return;
  const r = btnRef.value.getBoundingClientRect();
  posRef.value = { top: `${r.bottom + 4}px`, left: `${r.left}px` };
}
function closeDrops(e) {
  if (!repoDropEl.value?.contains(e.target)  && !repoBtnEl.value?.contains(e.target))  repoDropOpen.value  = false;
  if (!scopeDropEl.value?.contains(e.target) && !scopeBtnEl.value?.contains(e.target)) scopeDropOpen.value = false;
  if (!wtDropEl.value?.contains(e.target)    && !wtBtnEl.value?.contains(e.target))    wtDropOpen.value    = false;
}
onMounted(()  => document.addEventListener('mousedown', closeDrops));
onUnmounted(()=> document.removeEventListener('mousedown', closeDrops));

// ── commit 列表 ────────────────────────────────────────────
const commits        = ref([]);
const commitsLoading = ref(false);

// ── worktree 选择 ──────────────────────────────────────────
const worktrees        = ref([]);
const selectedWorktree = ref('');      // 全局 worktree 选择（空=主仓库）
const wtDropOpen       = ref(false);
const wtBtnEl          = ref(null);
const wtDropEl         = ref(null);
const wtDropPos        = ref({ top: '0px', left: '0px' });
const wtLoading        = ref(false);

async function loadWorktrees() {
  if (!selectedRepo.value || wtLoading.value) return;
  wtLoading.value = true;
  try {
    worktrees.value = await http.getWorktrees(props.taskId, selectedRepo.value.path);
  } catch { worktrees.value = []; }
  finally { wtLoading.value = false; }
}

function openWtDrop() {
  repoDropOpen.value  = false;
  scopeDropOpen.value = false;
  wtDropOpen.value    = !wtDropOpen.value;
  if (wtDropOpen.value) {
    loadWorktrees();
    nextTick(() => calcDropPos(wtBtnEl, wtDropPos));
  }
}

function selectWorktree(wtPath) {
  selectedWorktree.value = wtPath;
  wtDropOpen.value = false;
  loadDiff();
}

const currentBranch = computed(() => {
  if (selectedWorktree.value) {
    const wt = worktrees.value.find(w => w.path === selectedWorktree.value);
    if (wt?.branch) return wt.branch;
  }
  return branch.value || '';
});

function selectRepo(idx) {
  selectedRepoIdx.value = idx;
  repoDropOpen.value    = false;
  // 切换仓库时重新加载 diff
  loadDiff();
}

async function selectCommit(c) {
  selectedCommit.value = c;
  scopeMode.value      = 'commit';
  scopeDropOpen.value  = false;
  await loadDiff();
}

function selectBranch() {
  scopeMode.value      = 'branch';
  selectedCommit.value = null;
  scopeDropOpen.value  = false;
  loadDiff();
}

function selectUncommitted() {
  scopeMode.value      = 'uncommitted';
  selectedCommit.value = null;
  scopeDropOpen.value  = false;
  loadDiff();
}

// 打开范围下拉时懒加载 commit 列表
async function loadCommitsIfNeeded() {
  if (!selectedRepo.value || commits.value.length || commitsLoading.value) return;
  commitsLoading.value = true;
  try {
    commits.value = await http.getCommits(props.taskId, selectedRepo.value.path);
  } catch { commits.value = []; }
  finally { commitsLoading.value = false; }
}


// ── Tab ──────────────────────────────────────────────────
const activeTab = ref(props.initialTab);

// ── Diff 状态 ─────────────────────────────────────────────
const diffLoading      = ref(false);
const diffError        = ref('');
const branch           = ref('');
const diffFiles        = ref([]);   // { path, absPath, added, deleted, untracked, repo }
const selectedDiffFile = ref('');   // 选中的文件 path（用于 UI 高亮）
const selectedDiffAbs  = ref('');   // 选中的绝对路径（用于 API 请求）

// 单文件 diff 内容（按需加载，替代原 rawDiff 本地解析）
const fileDiffContent = ref('');
const fileDiffLoading = ref(false);
const fileDiffError   = ref('');

const selectedDiffLines = computed(() => {
  if (!fileDiffContent.value) return [];
  return fileDiffContent.value.split('\n')
    .map(text => {
      if (text.startsWith('@@'))                                              return { type: 'hunk', text };
      if (text.startsWith('+') && !text.startsWith('+++'))                   return { type: 'add',  text: text.slice(1) };
      if (text.startsWith('-') && !text.startsWith('---'))                   return { type: 'del',  text: text.slice(1) };
      if (/^(diff |index |--- |\+\+\+ |new file|deleted|old mode|new mode)/.test(text))
                                                                             return { type: 'meta', text };
      return { type: 'ctx', text: text.startsWith(' ') ? text.slice(1) : text };
    })
    .filter(l => l.type !== 'meta');
});

// 按选中仓库过滤（多仓库时只显示当前仓库的文件）
const visibleFiles = computed(() => {
  if (!selectedRepo.value || repos.value.length <= 1) return diffFiles.value;
  const name = repoName(selectedRepo.value);
  return diffFiles.value.filter(f => f.repo === name || !f.repo);
});

const totalAdded   = computed(() => visibleFiles.value.reduce((s, f) => s + f.added,   0));
const totalDeleted = computed(() => visibleFiles.value.reduce((s, f) => s + f.deleted, 0));

async function loadDiff() {
  diffLoading.value = true;
  diffError.value   = '';
  // 重置文件选中
  selectedDiffFile.value = '';
  selectedDiffAbs.value  = '';
  fileDiffContent.value  = '';
  try {
    const params = { mode: scopeMode.value };
    if (selectedRepo.value?.path) params.repoPath = selectedRepo.value.path;
    if (selectedWorktree.value) params.worktreePath = selectedWorktree.value;
    if (scopeMode.value === 'commit' && selectedCommit.value?.hash) {
      params.hash = selectedCommit.value.hash;
    }
    const d = await http.getDiff(props.taskId, params);
    branch.value    = d.branch;
    diffFiles.value = d.files;
    if (d.files.length) selectDiffFile(d.files[0]);
  } catch (e) {
    diffError.value = e.message;
  } finally {
    diffLoading.value = false;
  }
}

/** 选中文件并加载其 diff 内容 */
function selectDiffFile(file) {
  selectedDiffFile.value = file.path;
  selectedDiffAbs.value  = file.absPath ?? file.path;
  loadFileDiff(file.absPath ?? file.path);
}

async function loadFileDiff(absPath) {
  if (!absPath) return;
  fileDiffLoading.value = true;
  fileDiffError.value   = '';
  fileDiffContent.value = '';
  try {
    const hash = scopeMode.value === 'commit' ? selectedCommit.value?.hash : undefined;
    const wtPath = selectedWorktree.value || undefined;
    fileDiffContent.value = await http.getDiffFile(props.taskId, absPath, hash, scopeMode.value, wtPath);
  } catch (e) {
    fileDiffError.value = e.message;
  } finally {
    fileDiffLoading.value = false;
  }
}

// ── 文档产出状态 ───────────────────────────────────────────
const docsLoading    = ref(false);
const artifacts      = ref({ reports: [], plans: [] });
const docContent     = ref('');
const docLoading     = ref(false);
const selectedDoc    = ref(props.initialArtifact ?? null);  // { category, filename }

async function loadArtifacts() {
  docsLoading.value = true;
  try {
    artifacts.value = await http.getArtifacts(props.taskId);
  } catch { /* 忽略 */ } finally {
    docsLoading.value = false;
  }
}

async function loadDocContent() {
  if (!selectedDoc.value) return;
  docLoading.value = true;
  docContent.value = '';
  try {
    docContent.value = await http.getArtifactContent(
      props.taskId,
      selectedDoc.value.category,
      selectedDoc.value.filename,
    );
  } catch (e) {
    docContent.value = `加载失败：${e.message}`;
  } finally {
    docLoading.value = false;
  }
}

// 不依赖 watch：点击芯片时直接更新 selectedDoc 并加载内容
function selectDoc(category, filename) {
  selectedDoc.value = { category, filename };
  loadDocContent();
}

// ── refreshTrigger：agent done 后自动刷新当前 tab ──────────
watch(() => props.refreshTrigger, (v, old) => {
  if (v === old) return;
  if (activeTab.value === 'diff') loadDiff();
  else loadArtifacts();
});

// InfoPanel 点击 diff 文件时，切换到对应文件并加载 diff
watch(() => props.initialDiffFile, (file) => {
  if (file) {
    const found = diffFiles.value.find(f => f.path === file || f.absPath === file);
    if (found) selectDiffFile(found);
    else { selectedDiffFile.value = file; loadFileDiff(file); }
    activeTab.value = 'diff';
  }
});

// 在 Finder 中显示产物文件（或目录）
async function revealInFinder(category, filename) {
  try { await http.revealArtifact(props.taskId, category, filename); }
  catch (e) { console.error('打开 Finder 失败:', e.message); }
}

// 去掉日期前缀和后缀，取可读标题
function docTitle(filename) {
  return filename
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')  // 日期前缀
    .replace(/\.(md|html)$/, '');          // 扩展名
}

// InfoPanel 点击文档产物时，切换到对应文件并加载内容
watch(() => props.initialArtifact, (artifact) => {
  if (artifact) {
    selectedDoc.value = artifact;
    activeTab.value = 'docs';
    loadDocContent();
  }
});

watch(() => props.initialDiffFile, (file) => {
  if (file) {
    // 在文件列表里找到对应条目（含 absPath），再调按需加载
    const found = diffFiles.value.find(f => f.path === file || f.absPath === file);
    if (found) selectDiffFile(found);
    else { selectedDiffFile.value = file; loadFileDiff(file); }
    activeTab.value = 'diff';
  }
});

// ── 初始化 ────────────────────────────────────────────────
onMounted(async () => {
  await Promise.all([loadDiff(), loadArtifacts()]);
  if (selectedDoc.value) await loadDocContent();
});
</script>

<template>
  <div class="output-panel">

    <!-- 头部 tab 切换 -->
    <div class="panel-header">
      <div class="tabs">
        <button class="tab-btn" :class="{ active: activeTab === 'diff' }" @click="activeTab = 'diff'">
          ⊿ 代码改动
          <span v-if="diffFiles.length" class="tab-badge">{{ diffFiles.length }}</span>
        </button>
        <button class="tab-btn" :class="{ active: activeTab === 'docs' }" @click="activeTab = 'docs'">
          📄 文档产出
          <span v-if="artifacts.reports.length + artifacts.plans.length" class="tab-badge">
            {{ artifacts.reports.length + artifacts.plans.length }}
          </span>
        </button>
      </div>
      <button
        class="icon-btn"
        :disabled="diffLoading || docsLoading"
        title="刷新"
        @click="activeTab === 'diff' ? loadDiff() : loadArtifacts()"
      >
        <span :class="{ spinning: diffLoading || docsLoading }">↺</span>
      </button>
      <!-- 打开产物目录按钮（仅文档 Tab 显示） -->
      <button
        v-if="activeTab === 'docs'"
        class="icon-btn"
        title="在 Finder 中打开产物目录"
        @click="revealInFinder(null, null)"
      >📂</button>
      <button class="icon-btn close" title="关闭" @click="$emit('close')">✕</button>
    </div>

    <!-- ── Tab 1：代码改动 ── -->
    <div v-show="activeTab === 'diff'" class="tab-content">

      <!-- 控制栏：仓库选择器 / 查看范围选择器 / 分支 badge -->
      <div class="diff-ctrl-bar">
        <!-- 仓库选择器 -->
        <button
          ref="repoBtnEl"
          class="ctrl-sel repo-sel"
          :class="{ open: repoDropOpen }"
          @click="openRepoDrop"
        >
          <span class="repo-dot"></span>
          <span class="ctrl-sel-text">{{ repoName(selectedRepo) || '选择仓库' }}</span>
          <span class="ctrl-arrow">{{ repoDropOpen ? '▴' : '▾' }}</span>
        </button>

        <span class="ctrl-div">/</span>

        <!-- 查看范围选择器 -->
        <Popover
          v-if="scopeMode === 'commit' && selectedCommit"
          :content="selectedCommit.message"
          :delay="200"
        >
          <button
            ref="scopeBtnEl"
            class="ctrl-sel scope-sel mode-commit"
            :class="{ open: scopeDropOpen }"
            @click="openScopeDrop"
          >
            <span>📌</span>
            <span class="ctrl-sel-text">{{ selectedCommit.hash.slice(0,7) }} · {{ selectedCommit.message }}</span>
            <span class="ctrl-arrow">{{ scopeDropOpen ? '▴' : '▾' }}</span>
          </button>
        </Popover>
        <button
          v-else-if="scopeMode === 'branch'"
          ref="scopeBtnEl"
          class="ctrl-sel scope-sel mode-branch"
          :class="{ open: scopeDropOpen }"
          @click="openScopeDrop"
        >
          <span>🔀</span>
          <span class="ctrl-sel-text">当前分支 vs 目标分支</span>
          <span class="ctrl-arrow">{{ scopeDropOpen ? '▴' : '▾' }}</span>
        </button>
        <button
          v-else
          ref="scopeBtnEl"
          class="ctrl-sel scope-sel mode-work"
          :class="{ open: scopeDropOpen }"
          @click="openScopeDrop"
        >
          <span>🔵</span>
          <span class="ctrl-sel-text">未提交内容</span>
          <span class="ctrl-arrow">{{ scopeDropOpen ? '▴' : '▾' }}</span>
        </button>

        <!-- worktree 选择器 -->
        <button
          ref="wtBtnEl"
          class="ctrl-sel wt-sel"
          :class="{ open: wtDropOpen, active: !!selectedWorktree }"
          @click="openWtDrop"
          :title="selectedWorktree || '主仓库'"
        >
          <span>🌳</span>
          <span class="ctrl-sel-text">{{ selectedWorktree ? selectedWorktree.split('/').pop() : '主仓库' }}</span>
          <span class="ctrl-arrow">{{ wtDropOpen ? '▴' : '▾' }}</span>
        </button>

        <!-- 分支 badge（只读，完整展示分支名）-->
        <div v-if="selectedRepo" class="branch-badge-ctrl">
          <span class="bb-branch" :title="currentBranch">{{ currentBranch }}</span>
          <span class="bb-arrow">→</span>
          <span class="bb-base" :title="selectedRepo.baseBranch">{{ selectedRepo.baseBranch }}</span>
        </div>
      </div>

      <!-- 仓库下拉（Teleport）-->
      <Teleport to="body">
        <Transition name="dropdown">
          <div
            v-if="repoDropOpen"
            ref="repoDropEl"
            class="ctrl-dropdown"
            :style="{ position: 'fixed', top: repoDropPos.top, left: repoDropPos.left }"
          >
            <div class="cdd-label">切换仓库</div>
            <div
              v-for="(r, i) in repos" :key="r.path"
              class="cdd-item"
              :class="{ sel: i === selectedRepoIdx }"
              @mousedown.prevent="selectRepo(i)"
            >
              <span class="cdd-dot" :class="diffFiles.some(f=>f.repo===repoName(r)) ? 'dot-active' : 'dot-idle'">●</span>
              <span class="cdd-name">{{ repoName(r) }}</span>
              <span class="cdd-stat">
                <span v-if="diffFiles.filter(f=>f.repo===repoName(r)).reduce((s,f)=>s+f.added,0)" style="color:#40c057">
                  +{{ diffFiles.filter(f=>f.repo===repoName(r)).reduce((s,f)=>s+f.added,0) }}
                </span>
              </span>
              <span v-if="i === selectedRepoIdx" class="cdd-chk">✓</span>
            </div>
          </div>
        </Transition>
      </Teleport>

      <!-- worktree 下拉（Teleport）-->
      <Teleport to="body">
        <Transition name="dropdown">
          <div
            v-if="wtDropOpen"
            ref="wtDropEl"
            class="ctrl-dropdown"
            :style="{ position: 'fixed', top: wtDropPos.top, left: wtDropPos.left }"
          >
            <div class="cdd-label">切换工作树</div>
            <div v-if="wtLoading" class="cdd-empty">加载中…</div>
            <template v-else>
              <div
                class="cdd-item"
                :class="{ sel: !selectedWorktree }"
                @mousedown.prevent="selectWorktree('')"
              >
                <span class="cdd-dot">🏠</span>
                <div class="cdd-item-main">
                  <div class="cdd-item-title">主仓库</div>
                  <div class="cdd-item-sub">{{ repoName(selectedRepo) }}</div>
                </div>
                <span v-if="!selectedWorktree" class="cdd-chk">✓</span>
              </div>
              <div
                v-for="wt in worktrees.filter(w => w.path !== selectedRepo?.path)"
                :key="wt.path"
                class="cdd-item"
                :class="{ sel: selectedWorktree === wt.path }"
                @mousedown.prevent="selectWorktree(wt.path)"
              >
                <span class="cdd-dot">🌳</span>
                <div class="cdd-item-main">
                  <div class="cdd-item-title">{{ wt.path.split('/').pop() }}</div>
                  <div class="cdd-item-sub">{{ wt.branch || '(detached)' }}</div>
                </div>
                <span v-if="selectedWorktree === wt.path" class="cdd-chk">✓</span>
              </div>
            </template>
          </div>
        </Transition>
      </Teleport>
      <Teleport to="body">
        <Transition name="dropdown">
          <div
            v-if="scopeDropOpen"
            ref="scopeDropEl"
            class="ctrl-dropdown"
            :style="{ position: 'fixed', top: scopeDropPos.top, left: scopeDropPos.left }"
          >
            <!-- 分支对比（默认）-->
            <div class="cdd-item" :class="{ sel: scopeMode === 'branch' }" @mousedown.prevent="selectBranch">
              <span>🔀</span>
              <div class="cdd-item-main">
                <div class="cdd-item-title">当前分支 vs 目标分支</div>
                <div class="cdd-item-sub">全部已提交改动 · 对比分支在中间栏配置</div>
              </div>
              <span v-if="scopeMode === 'branch'" class="cdd-chk">✓</span>
            </div>

            <!-- 未提交内容 -->
            <div class="cdd-item" :class="{ sel: scopeMode === 'uncommitted' }" @mousedown.prevent="selectUncommitted">
              <span>🔵</span>
              <div class="cdd-item-main">
                <div class="cdd-item-title">未提交内容</div>
                <div class="cdd-item-sub">已暂存 · 未暂存 · 未追踪文件</div>
              </div>
              <span v-if="scopeMode === 'uncommitted'" class="cdd-chk">✓</span>
            </div>

            <!-- commit 列表 -->
            <div class="cdd-group-label">查看某次 Commit</div>
            <div v-if="commitsLoading" class="cdd-empty">加载中…</div>
            <div v-else-if="!commits.length" class="cdd-empty">暂无 commit 记录（后端待实现）</div>
            <template v-else>
              <div
                v-for="c in commits" :key="c.hash"
                class="cdd-commit-row"
                :class="{ sel: selectedCommit?.hash === c.hash }"
                @mousedown.prevent="selectCommit(c)"
              >
                <span class="cdd-hash">{{ c.hash.slice(0,7) }}</span>
                <Popover :content="c.message" :delay="400">
                  <span class="cdd-msg">{{ c.message }}</span>
                </Popover>
                <span class="cdd-time">{{ c.relTime }}</span>
              </div>
            </template>
          </div>
        </Transition>
      </Teleport>

      <div v-if="diffLoading && !diffFiles.length" class="state-msg">加载中…</div>
      <div v-else-if="diffError" class="state-msg warn">⚠ {{ diffError }}</div>
      <div v-else-if="!diffFiles.length" class="state-msg">暂无代码改动</div>

      <template v-else>
        <!-- 改动摘要行 -->
        <div class="diff-meta">
          <span class="diff-stats">
            <span class="add-count">+{{ totalAdded }}</span>
            <span class="del-count">-{{ totalDeleted }}</span>
            <span class="file-count">{{ visibleFiles.length }} 文件</span>
          </span>
        </div>

        <div class="diff-body">
          <!-- 目录树文件列表 -->
          <DiffTree
            :files="visibleFiles"
            :selected-path="selectedDiffFile"
            :loading="diffLoading"
            @select-file="selectDiffFile"
          />

          <!-- diff 内容（按需加载） -->
          <div class="diff-view">
            <div class="diff-filepath" :title="selectedDiffFile">{{ selectedDiffFile }}</div>
            <div v-if="fileDiffLoading" class="state-msg">加载中…</div>
            <div v-else-if="fileDiffError" class="state-msg warn">⚠ {{ fileDiffError }}</div>
            <div v-else-if="!selectedDiffLines.length" class="state-msg">（无内容变化）</div>
            <div v-else class="diff-lines">
              <div
                v-for="(line, i) in selectedDiffLines" :key="i"
                class="diff-line"
                :class="line.type"
              >
                <span class="line-mark">
                  {{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'hunk' ? '…' : ' ' }}
                </span>
                <span class="line-text">{{ line.text }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>

    </div>

    <!-- ── Tab 2：文档产出 ── -->
    <div v-show="activeTab === 'docs'" class="tab-content">

      <div v-if="docsLoading && !artifacts.reports.length && !artifacts.plans.length" class="state-msg">
        加载中…
      </div>
      <div v-else-if="!artifacts.reports.length && !artifacts.plans.length" class="state-msg">
        暂无文档产出
      </div>

      <template v-else>
        <!-- 文档列表（紧凑横排，带类型标识） -->
        <div class="doc-file-list">
          <template v-if="artifacts.reports.length">
            <span class="doc-group-label report-label">报告</span>
            <span
              v-for="f in artifacts.reports" :key="'r-' + f"
              class="doc-file-chip"
              :class="[
                { active: selectedDoc?.category === 'reports' && selectedDoc?.filename === f },
                f.endsWith('.html') ? 'chip-html' : 'chip-md'
              ]"
              :title="f"
              @click="selectDoc('reports', f)"
            >
              <span class="chip-icon">{{ f.endsWith('.html') ? '🌐' : '📄' }}</span>
              <span class="chip-name">{{ docTitle(f) }}</span>
              <span class="chip-type">{{ f.endsWith('.html') ? 'HTML' : 'MD' }}</span>
            </span>
          </template>
          <template v-if="artifacts.plans.length">
            <span class="doc-group-label plan-label">方案</span>
            <span
              v-for="f in artifacts.plans" :key="'p-' + f"
              class="doc-file-chip"
              :class="[
                { active: selectedDoc?.category === 'plans' && selectedDoc?.filename === f },
                f.endsWith('.html') ? 'chip-html' : 'chip-md'
              ]"
              :title="f"
              @click="selectDoc('plans', f)"
            >
              <span class="chip-icon">{{ f.endsWith('.html') ? '🌐' : '📋' }}</span>
              <span class="chip-name">{{ docTitle(f) }}</span>
              <span class="chip-type">{{ f.endsWith('.html') ? 'HTML' : 'MD' }}</span>
            </span>
          </template>
        </div>

        <!-- 文档内容：HTML 用 iframe 渲染，MD 用 pre 展示 -->
        <div class="doc-view">
          <div v-if="!selectedDoc" class="state-msg">↑ 点击文件查看内容</div>
          <template v-else>
            <div class="doc-header">
              <span class="diff-filepath">{{ selectedDoc.filename }}</span>
              <span class="doc-type-badge" :class="selectedDoc.filename.endsWith('.html') ? 'badge-html' : 'badge-md'">
                {{ selectedDoc.filename.endsWith('.html') ? 'HTML' : 'Markdown' }}
              </span>
              <button
                class="reveal-btn"
                title="在 Finder 中显示"
                @click="revealInFinder(selectedDoc.category, selectedDoc.filename)"
              >📂 显示</button>
            </div>
            <div v-if="docLoading" class="state-msg">加载中…</div>
            <!-- HTML 文件：iframe 渲染 -->
            <iframe
              v-else-if="selectedDoc.filename.endsWith('.html')"
              class="doc-iframe"
              :srcdoc="docContent"
              sandbox="allow-scripts"
            ></iframe>
            <!-- MD 文件：纯文本展示 -->
            <pre v-else class="doc-content">{{ docContent }}</pre>
          </template>
        </div>
      </template>

    </div>
  </div>
</template>

<style scoped>
.output-panel {
  display: flex; flex-direction: column;
  background: var(--bg-surface-3); border-left: 1px solid var(--border);
  overflow: hidden; min-width: 260px;
}

/* ── 头部 ── */
.panel-header {
  display: flex; align-items: center; gap: 2px;
  padding: 0 10px; height: 42px; flex-shrink: 0;
  border-bottom: 1px solid var(--border); background: var(--bg-surface);
}

.tabs { display: flex; gap: 2px; flex: 1; }

.tab-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 10px; border: none; border-radius: 6px;
  font-size: 11px; font-weight: 600; cursor: pointer;
  color: var(--text-muted); background: transparent;
  transition: color 0.12s, background 0.12s;
}
.tab-btn:hover  { color: #aaa; background: #1e1e2a; }
.tab-btn.active { color: var(--text-primary); background: #2a2a38; }

.tab-badge {
  font-size: 10px; background: #2a2a38; color: #7b8cde;
  border-radius: 8px; padding: 0 5px; line-height: 16px;
}
.tab-btn.active .tab-badge { background: var(--bg-surface); }

.icon-btn {
  width: 28px; height: 28px; flex-shrink: 0;
  background: transparent; border: none; border-radius: 6px;
  color: #444; font-size: 13px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.12s, background 0.12s;
}
.icon-btn:hover       { color: #888; background: #1e1e2a; }
.icon-btn.close:hover { color: #e03131; }
.icon-btn:disabled    { opacity: 0.4; cursor: not-allowed; }

.spinning { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── 控制栏 ── */
.diff-ctrl-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 12px; border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
  background: var(--bg-surface-3);
}
.ctrl-sel {
  display: inline-flex; align-items: center; gap: 5px; max-width: 200px;
  padding: 4px 9px; border-radius: 7px; cursor: pointer; flex-shrink: 0;
  border: 1px solid var(--border); background: var(--bg-surface);
  font-size: 11px; font-weight: 500; color: var(--text-secondary);
  transition: border-color .12s;
}
.ctrl-sel:hover { border-color: #3b5bdb; }
.ctrl-sel.open  { border-color: #3b5bdb; outline: 2px solid rgba(59,91,219,.2); }
.ctrl-sel-text  { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctrl-arrow     { font-size: 8px; opacity: .6; flex-shrink: 0; }

.repo-sel  { }
.repo-dot  { width: 6px; height: 6px; border-radius: 50%; background: #3b5bdb; flex-shrink: 0; }
.scope-sel { font-family: inherit; }
.mode-branch { color: #69d999; border-color: rgba(105,217,153,.35); background: rgba(105,217,153,.05); }
.mode-work   { color: #7b8cde; border-color: rgba(59,91,219,.3); }
.mode-commit { color: #c09030; border-color: rgba(245,159,0,.35); background: rgba(245,159,0,.05); }

.ctrl-div { color: var(--border); font-size: 15px; font-weight: 300; }

/* worktree 选择器 */
.wt-sel { font-family: inherit; }
.wt-sel.active { color: #69d999; border-color: rgba(105,217,153,.35); background: rgba(105,217,153,.05); }

/* 分支 badge（右侧只读）*/
.branch-badge-ctrl {
  margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; font-weight: 600; font-family: "SF Mono", Menlo, monospace;
  padding: 3px 8px; border-radius: 6px;
  background: rgba(59,91,219,.07); color: #5a6aae;
  border: 1px solid rgba(59,91,219,.14); white-space: nowrap; flex-shrink: 0;
}
.bb-arrow { color: #3b5bdb; font-size: 9px; }
.bb-branch, .bb-base { white-space: nowrap; }

/* ── 控制栏下拉（共用）── */
.ctrl-dropdown {
  z-index: 9999; min-width: 240px; max-width: 320px;
  background: #1a1a24; border: 1px solid #3b5bdb;
  border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.55);
  overflow: hidden; padding: 4px 0;
}
.cdd-label, .cdd-group-label {
  font-size: 9px; font-weight: 700; color: #2a2a40;
  text-transform: uppercase; letter-spacing: .08em;
  padding: 8px 12px 3px;
}
.cdd-item {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 12px; cursor: pointer; font-size: 12px;
  color: #9898b8; transition: background .08s;
}
.cdd-item:hover { background: #1e2030; color: #c8c8d8; }
.cdd-item.sel   { background: rgba(59,91,219,.1); color: #7b8cde; }
.cdd-dot { font-size: 8px; flex-shrink: 0; }
.dot-active { color: #40c057; } .dot-idle { color: #2a2a38; }
.cdd-name { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdd-stat { font-size: 10px; flex-shrink: 0; }
.cdd-chk  { font-size: 10px; color: #3b5bdb; flex-shrink: 0; }
.cdd-item-main { flex: 1; min-width: 0; }
.cdd-item-title { font-size: 12px; font-weight: 600; }
.cdd-item-sub   { font-size: 10px; color: #3a3a55; margin-top: 1px; }

/* commit 行 */
.cdd-commit-row {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 12px 5px 24px; cursor: pointer; transition: background .08s;
}
.cdd-commit-row:hover { background: #1e2030; }
.cdd-commit-row.sel   { background: rgba(59,91,219,.1); }
.cdd-hash { font-size: 10px; color: #2a2a48; font-family: "SF Mono",Menlo,monospace; flex-shrink: 0; min-width: 50px; }
.cdd-msg  { flex: 1; font-size: 11px; color: #6060a0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdd-time { font-size: 10px; color: #2a2a38; flex-shrink: 0; }
.cdd-empty { padding: 10px 12px; font-size: 11px; color: #2a2a38; font-style: italic; }

/* 下拉动画 */
.dropdown-enter-active, .dropdown-leave-active { transition: opacity .12s, transform .1s; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-4px); }

/* ── 状态提示 ── */
.state-msg {
  padding: 24px 16px; color: #444; font-size: 12px;
  display: flex; align-items: center; justify-content: center;
}
.state-msg.warn { color: #c17700; }

/* ── Tab 容器 ── */
.tab-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }

/* ── 共用：左文件列 + 右内容 ── */
.diff-body, .docs-body {
  flex: 1; display: flex; overflow: hidden; min-height: 0;
}

/* 摘要行 */
.diff-meta {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-bottom: 1px solid var(--border-sub);
  flex-shrink: 0;
}
.branch-badge {
  font-size: 10px; font-weight: 600; color: #7b8cde;
  background: rgba(123,140,222,0.1); border: 1px solid rgba(123,140,222,0.2);
  border-radius: 8px; padding: 1px 7px;
  max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.diff-stats { display: flex; gap: 6px; font-size: 11px; font-weight: 600; }
.file-count { color: #444; font-weight: 400; }
.add-count { color: #40c057; }
.del-count { color: #e03131; }

/* 文件列表（共用） */
.file-list {
  width: 150px; flex-shrink: 0;
  overflow-y: auto; border-right: 1px solid #1e1e2a;
  padding: 4px 0;
}

.list-group {
  font-size: 9px; font-weight: 700; color: #444;
  text-transform: uppercase; letter-spacing: 0.08em;
  padding: 8px 10px 3px;
}

.file-item {
  display: flex; align-items: center; gap: 4px;
  padding: 5px 8px; cursor: pointer; font-size: 11px; color: #555;
  border-left: 2px solid transparent;
  transition: background 0.1s, color 0.1s;
  min-height: 0;
}
.file-item:hover  { background: var(--bg-surface); color: #999; }
.file-item.active { background: var(--bg-surface); color: #7b8cde; border-left-color: #3b5bdb; }
.file-item.file-untracked { color: #4a7a4a; }
.file-item.file-untracked.active { color: #69d999; border-left-color: #40c057; background: rgba(64,192,87,.08); }
.untracked-dot { font-size: 7px; color: #40c057; margin-right: 2px; vertical-align: middle; }

.file-name {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: "SF Mono", Menlo, monospace; font-size: 10.5px;
}
.file-stats { display: flex; gap: 3px; font-size: 10px; flex-shrink: 0; }

.doc-icon { flex-shrink: 0; font-size: 12px; }

/* ── Diff 视图 ── */
.diff-view {
  flex: 1; overflow: auto; min-width: 0;
  display: flex; flex-direction: column;
}

.diff-filepath {
  font-size: 11px; color: #444; padding: 6px 10px;
  border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
  font-family: "SF Mono", Menlo, monospace;
  position: sticky; top: 0; background: var(--bg-surface-3); z-index: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.diff-lines { font-family: "JetBrains Mono","SF Mono",Menlo,monospace; font-size: 11.5px; }

.diff-line {
  display: flex; align-items: stretch; min-height: 18px; line-height: 18px;
}
.diff-line.add  { background: rgba(64,192,87,0.1); }
.diff-line.del  { background: rgba(224,49,49,0.12); }
.diff-line.hunk { background: rgba(59,91,219,0.1); }

.line-mark {
  width: 16px; flex-shrink: 0; text-align: center;
  font-size: 11px; padding-top: 1px; user-select: none;
}
.diff-line.add  .line-mark { color: #40c057; }
.diff-line.del  .line-mark { color: #e03131; }
.diff-line.hunk .line-mark { color: #7b8cde; }
.diff-line.ctx  .line-mark { color: #333; }

.line-text { flex: 1; white-space: pre; padding: 0 8px; color: var(--text-secondary); }
.diff-line.add  .line-text { color: #b3f5c4; }
.diff-line.del  .line-text { color: #f5b3b3; }
.diff-line.hunk .line-text { color: #7b8cde; font-style: italic; }

/* ── 文档 Tab：文件选择列（横排紧凑，带类型标识） ── */
.doc-file-list {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 5px 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
  background: var(--bg-surface-3);
}
.doc-group-label {
  font-size: 9px; font-weight: 800; letter-spacing: 0.1em;
  text-transform: uppercase; padding: 2px 6px; border-radius: 4px;
}
.report-label { color: #7b8cde; background: rgba(123,140,222,.1); }
.plan-label   { color: #69d999; background: rgba(105,217,153,.1); }

.doc-file-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px; border-radius: 8px; cursor: pointer;
  font-size: 11px; background: var(--bg-surface); border: 1px solid var(--border-sub);
  white-space: nowrap; transition: all 0.12s;
  max-width: 200px;
}
.doc-file-chip:hover { border-color: var(--border); background: #1e1e2a; }

/* MD 类型 */
.doc-file-chip.chip-md         { color: #8080a0; }
.doc-file-chip.chip-md:hover   { color: #aaa; }
.doc-file-chip.chip-md.active  { color: #7b8cde; border-color: #3b5bdb; background: var(--bg-surface); }

/* HTML 类型 */
.doc-file-chip.chip-html        { color: #709060; border-color: rgba(105,217,153,.15); }
.doc-file-chip.chip-html:hover  { color: #90c080; border-color: rgba(105,217,153,.3); }
.doc-file-chip.chip-html.active { color: #69d999; border-color: #4cae7a; background: rgba(105,217,153,.08); }

.chip-icon { font-size: 12px; flex-shrink: 0; }
.chip-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.chip-type {
  font-size: 8px; font-weight: 700; letter-spacing: 0.05em;
  opacity: 0.5; flex-shrink: 0; font-family: "SF Mono", Menlo, monospace;
}

/* ── 文档视图 ── */
.doc-view {
  flex: 1; overflow: auto; min-width: 0;
  display: flex; flex-direction: column;
}

/* 文档头部：文件路径 + 类型标签 */
.doc-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-bottom: 1px solid var(--border-sub);
  flex-shrink: 0;
}
.doc-type-badge {
  font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
  padding: 1px 6px; border-radius: 4px; flex-shrink: 0;
}
.badge-md   { background: rgba(123,140,222,.12); color: #7b8cde; }
.badge-html { background: rgba(105,217,153,.1);  color: #69d999; }

.reveal-btn {
  margin-left: auto; flex-shrink: 0;
  padding: 2px 8px; font-size: 11px;
  background: transparent; border: 1px solid var(--border);
  border-radius: 5px; color: #555; cursor: pointer;
  transition: all 0.12s;
}
.reveal-btn:hover { border-color: #444; color: #aaa; background: #1e1e2a; }

/* HTML iframe */
.doc-iframe {
  flex: 1; border: none; background: #fff;
  width: 100%; min-height: 0;
}

/* MD 纯文本 */
.doc-content {
  padding: 12px 14px; font-size: 12px; line-height: 1.75;
  color: #b0b0c8; white-space: pre-wrap; word-break: break-word;
  font-family: "SF Mono", Menlo, monospace; margin: 0;
}
</style>
