<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { http } from '../api/http.js';
import BranchSelector from './BranchSelector.vue';
import ConventionPanel from './ConventionPanel.vue';
import SkillListPanel from './SkillListPanel.vue';

const activeTab = ref('info');        // 'info' | 'conventions' | 'skills'
const convPanelRef = ref(null);
function switchTab(t) {
  activeTab.value = t;
  if (t === 'conventions') convPanelRef.value?.reload();
}

const props = defineProps({
  taskId: { type: String, required: true },
  task:   { type: Object, default: null },   // 完整 task meta，含 scopeEnabled / watchedRepos
});

const emit = defineEmits(['open-artifact', 'open-diff', 'task-updated']);

// ── 改动范围管理 ────────────────────────────────────────────
const scopeEnabled   = computed(() => props.task?.scopeEnabled ?? false);
const watchedRepos   = computed(() => props.task?.watchedRepos ?? []);
const pickingRepo    = ref(false);

async function toggleScope() {
  try {
    const updated = await http.setScopeEnabled(props.taskId, !scopeEnabled.value);
    emit('task-updated', updated);
  } catch (e) { console.error('切换固定范围失败', e); }
}

const defaultBranch = ref('master');   // 添加新 repo 时使用的基准分支

async function addRepo() {
  pickingRepo.value = true;
  try {
    const { path } = await http.pickDirectory();
    if (!path) return;
    const res = await http.addWatchedRepo(props.taskId, path, defaultBranch.value || 'master');
    emit('task-updated', { ...props.task, watchedRepos: res.watchedRepos });
  } catch { /* 取消或失败 */ }
  finally { pickingRepo.value = false; }
}

// BranchSelector 选完分支后触发更新
async function onBranchChange(repo, newBranch) {
  if (newBranch === repo.baseBranch) return;
  try {
    const res = await http.updateWatchedRepoBranch(props.taskId, repo.path, newBranch);
    emit('task-updated', { ...props.task, watchedRepos: res.watchedRepos });
  } catch (e) { console.error('更新 baseBranch 失败', e); }
}

async function removeRepo(p) {
  try {
    const res = await http.removeWatchedRepo(props.taskId, p);
    emit('task-updated', { ...props.task, watchedRepos: res.watchedRepos });
  } catch (e) { console.error('移除 repo 失败', e); }
}

const context   = ref(null);
const artifacts = ref({ reports: [], plans: [] });

// 代码改动（git diff 摘要）
const diff = ref(null);   // { branch, files } | null

const totalAdded   = computed(() => diff.value?.files?.reduce((s, f) => s + f.added,   0) ?? 0);
const totalDeleted = computed(() => diff.value?.files?.reduce((s, f) => s + f.deleted, 0) ?? 0);

// ── context + artifacts：轻量，10s 定时轮询 ──────────────────
async function loadContext() {
  try {
    context.value   = await http.getTaskContext(props.taskId);
    artifacts.value = await http.getArtifacts(props.taskId);
  } catch (e) {
    console.error('加载任务信息失败:', e);
  }
}

// ── diff：事件驱动，不参与定时轮询 ───────────────────────────
// 获取最新 diff 的时机：
//   1. 组件挂载时（首次）
//   2. task.status 变为 reviewing（agent 完成一轮工作）
//   3. OutputPanel 打开时（OutputPanel 自己处理）
async function loadDiff() {
  try {
    const d = await http.getDiff(props.taskId);
    diff.value = d.files?.length ? d : null;
  } catch {
    diff.value = null;
  }
}

// 监听 task.status → reviewing 时刷新 diff
watch(() => props.task?.status, (newStatus, oldStatus) => {
  if (newStatus === 'reviewing' && oldStatus !== 'reviewing') {
    loadDiff();
  }
});

let timer = null;

function artifactTitle(filename) {
  return filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.(md|html)$/, '');
}

// 兼容处理：progress 的 steps 可能是数组（task:progress 工具写入）
// 也可能是逗号分隔字符串（Claude 直接 Write 写入）
function normalizeSteps(steps) {
  if (!steps) return [];
  if (Array.isArray(steps)) return steps;
  if (typeof steps === 'string') return steps.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

onMounted(() => {
  loadContext();
  loadDiff();                           // 首次加载 diff
  timer = setInterval(loadContext, 10000); // 只轮询 context + artifacts
});

onUnmounted(() => {
  clearInterval(timer);
});
</script>

<template>
  <div class="info-panel">
    <div class="panel-tabs">
      <span class="p-tab" :class="{ active: activeTab === 'info' }" @click="switchTab('info')">信息</span>
      <span class="p-tab" :class="{ active: activeTab === 'conventions' }" @click="switchTab('conventions')">规范</span>
      <span class="p-tab" :class="{ active: activeTab === 'skills' }" @click="switchTab('skills')">技能</span>
    </div>
    <div class="tab-body tab-scroll" v-show="activeTab === 'info'">
    <div v-if="!context" class="loading">加载中…</div>
    <template v-else>

      <!-- 任务目的 -->
      <section class="section">
        <div class="section-title">任务目的</div>
        <div class="purpose-text">{{ context.purpose || '（暂无描述）' }}</div>
      </section>

      <!-- 执行进度 -->
      <section class="section">
        <div class="section-title">执行进度</div>
        <div v-if="context.progress.summary" class="summary-text">{{ context.progress.summary }}</div>
        <div v-for="step in normalizeSteps(context.progress.completedSteps)" :key="step" class="step step-done">
          <span class="step-icon">✓</span> {{ step }}
        </div>
        <div v-for="step in normalizeSteps(context.progress.pendingSteps)" :key="step" class="step step-pending">
          <span class="step-icon">○</span> {{ step }}
        </div>
        <div v-if="!normalizeSteps(context.progress.completedSteps).length && !normalizeSteps(context.progress.pendingSteps).length" class="empty-hint">
          暂无进度记录
        </div>
      </section>

      <!-- 踩坑日记 -->
      <section class="section">
        <div class="section-title">踩坑日记</div>
        <div v-for="(item, i) in context.pitfalls.items" :key="i" class="pitfall-item">
          <div class="pitfall-type">⚠ {{ item.type }}</div>
          <div class="pitfall-desc">{{ item.description }}</div>
          <div v-if="item.solution" class="pitfall-solution">→ {{ item.solution }}</div>
        </div>
        <div v-if="!context.pitfalls.items?.length" class="empty-hint">暂无踩坑记录</div>
      </section>

      <!-- 改动范围 -->
      <section class="section">
        <!-- 标题行 + 固定范围开关 -->
        <div class="section-title scope-title-row">
          <span>改动范围</span>
          <span class="scope-toggle-area" @click.stop="toggleScope">
            <span class="scope-toggle-label" :class="{ active: scopeEnabled }">
              {{ scopeEnabled ? '固定范围' : '固定范围' }}
            </span>
            <span class="mini-switch" :class="{ on: scopeEnabled }">
              <span class="mini-switch-thumb"></span>
            </span>
          </span>
        </div>

        <!-- 无 repo 时：引导提示 -->
        <div v-if="!watchedRepos.length && !scopeEnabled" class="empty-hint" style="line-height:1.7">
          AI 将在首轮自动声明涉及的写入目录
        </div>

        <!-- repo 列表 -->
        <div v-if="watchedRepos.length" class="scope-repo-list-panel">
          <!-- 约束模式提示 -->
          <div v-if="scopeEnabled" class="scope-constraint-tip">
            ■ 写入约束已生效 · AI 只能在以下目录内修改文件
          </div>
          <!-- AI 声明提示 -->
          <div v-else class="scope-track-tip">
            ✦ AI 声明的写入目录（仅 diff 追踪，无写入约束）
          </div>

          <div
            v-for="repo in watchedRepos" :key="repo.path ?? repo"
            class="scope-repo-row"
            :class="{ constrained: scopeEnabled }"
          >
            <span class="scope-repo-dot" :class="scopeEnabled ? 'dot-blue' : 'dot-green'"></span>
            <span class="scope-repo-text" :title="repo.path ?? repo">
              {{ (repo.path ?? repo).replace(/\/+$/, '').split('/').pop() }}
            </span>
            <!-- BranchSelector：选择对比分支 -->
            <BranchSelector
              :model-value="repo.baseBranch ?? 'master'"
              :repo-path="repo.path ?? repo"
              @update:model-value="onBranchChange(repo, $event)"
            />
            <button v-if="scopeEnabled" class="scope-repo-rm" @click="removeRepo(repo.path ?? repo)">✕</button>
          </div>
        </div>

        <!-- 添加按钮区（仅 scopeEnabled 时显示） -->
        <div v-if="scopeEnabled" class="scope-add-area">
          <!-- 新 repo 的基准分支（无 repoPath，允许自由输入） -->
          <BranchSelector
            v-model="defaultBranch"
            repo-path=""
            placeholder="对比分支"
          />
          <button class="scope-add-panel-btn" :disabled="pickingRepo" @click="addRepo">
            {{ pickingRepo ? '选择中…' : '＋ 添加目录' }}
          </button>
        </div>
      </section>

      <!-- 代码改动：只显示总量，点击打开右侧 diff 面板 -->
      <section class="section" :class="{ 'section-clickable': !!diff }" @click="diff && emit('open-diff', '')">
        <div class="section-title">
          <span>代码改动</span>
          <span v-if="diff" class="diff-summary">
            <span class="add-count">+{{ totalAdded }}</span>
            <span class="del-count">-{{ totalDeleted }}</span>
            <span class="diff-file-count">{{ diff.files.length }} 文件</span>
            <span class="diff-open-hint">›</span>
          </span>
        </div>
        <div v-if="!diff" class="empty-hint">暂无代码改动</div>
      </section>

      <!-- 产出物 -->
      <section class="section section-last">
        <div class="section-title">产出物</div>
        <div v-if="artifacts.reports.length">
          <div class="artifact-category report-cat">📊 报告</div>
          <div
            v-for="f in artifacts.reports"
            :key="f"
            class="artifact-item"
            :class="f.endsWith('.html') ? 'artifact-html' : 'artifact-md'"
            @click="emit('open-artifact', 'reports', f)"
          >
            <span class="artifact-icon">{{ f.endsWith('.html') ? '🌐' : '📄' }}</span>
            <span class="artifact-name">{{ artifactTitle(f) }}</span>
            <span class="artifact-ext" :class="f.endsWith('.html') ? 'ext-html' : 'ext-md'">
              {{ f.endsWith('.html') ? 'HTML' : 'MD' }}
            </span>
          </div>
        </div>
        <div v-if="artifacts.plans.length">
          <div class="artifact-category plan-cat">📐 方案</div>
          <div
            v-for="f in artifacts.plans"
            :key="f"
            class="artifact-item"
            :class="f.endsWith('.html') ? 'artifact-html' : 'artifact-md'"
            @click="emit('open-artifact', 'plans', f)"
          >
            <span class="artifact-icon">{{ f.endsWith('.html') ? '🌐' : '📋' }}</span>
            <span class="artifact-name">{{ artifactTitle(f) }}</span>
            <span class="artifact-ext" :class="f.endsWith('.html') ? 'ext-html' : 'ext-md'">
              {{ f.endsWith('.html') ? 'HTML' : 'MD' }}
            </span>
          </div>
        </div>
        <div v-if="!artifacts.reports.length && !artifacts.plans.length" class="empty-hint">暂无产出物</div>
      </section>

    </template>
    </div>
    <ConventionPanel v-show="activeTab === 'conventions'" ref="convPanelRef" :task-id="taskId" class="tab-body" />
    <SkillListPanel v-show="activeTab === 'skills'" class="tab-body" />
  </div>
</template>

<style scoped>
.panel-tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--bg-surface); flex-shrink: 0; }
.p-tab { flex: 1; text-align: center; font-size: 12px; padding: 10px 0; color: var(--text-muted); cursor: pointer; }
.p-tab.active { color: var(--text-primary); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.info-panel {
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  font-size: 12px;
}
/* tab 内容区：占满 tabs 之下的剩余高度，各自管理滚动，避免 panel-tabs 高度挤压内容 */
.tab-body { flex: 1; min-height: 0; }
.tab-scroll { overflow-y: auto; }
.loading { padding: 20px; color: #555; }
.section {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.section-last { border-bottom: none; }
.section-title {
  font-size: 10px; font-weight: 700; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.08em;
  margin-bottom: 8px;
  display: flex; align-items: center;
}
.purpose-text {
  color: #888; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
}
.summary-text { color: #666; margin-bottom: 6px; font-style: italic; }
.step { display: flex; gap: 6px; color: #aaa; margin: 4px 0; line-height: 1.4; }
.step-icon { flex-shrink: 0; margin-top: 1px; }
.step-done .step-icon { color: #40c057; }
.step-pending .step-icon { color: #555; }
.pitfall-item {
  margin: 6px 0; padding: 8px 10px;
  background: var(--bg-surface-3); border-radius: 6px;
  border-left: 2px solid #fab005;
}
.pitfall-type { color: #fab005; font-weight: 600; font-size: 11px; margin-bottom: 3px; }
.pitfall-desc { color: #999; line-height: 1.5; }
.pitfall-solution { color: #666; margin-top: 4px; font-style: italic; }
/* 改动范围区块 */
.scope-title-row { justify-content: space-between; cursor: default; margin-bottom: 8px; }

.scope-toggle-area {
  display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none;
}
.scope-toggle-label {
  font-size: 10px; color: var(--text-dim); text-transform: none;
  letter-spacing: 0; font-weight: 600; transition: color .12s;
}
.scope-toggle-label.active { color: #5060b0; }

/* Mini switch */
.mini-switch {
  width: 28px; height: 16px; border-radius: 8px; flex-shrink: 0;
  position: relative; transition: background .2s;
  background: var(--border); border: 1px solid var(--border);
}
.mini-switch.on { background: var(--accent); border-color: var(--accent); }
.mini-switch-thumb {
  width: 10px; height: 10px; border-radius: 50%; background: white; opacity: .7;
  position: absolute; top: 2px; transition: left .18s;
}
.mini-switch.on  .mini-switch-thumb { left: 15px; opacity: 1; }
.mini-switch:not(.on) .mini-switch-thumb { left: 2px; }

/* Repo 列表 */
.scope-repo-list-panel { margin-bottom: 6px; }
.scope-constraint-tip {
  font-size: 10px; color: #5060b0; padding: 4px 6px; margin-bottom: 5px;
  background: rgba(59,91,219,.06); border-radius: 4px; border-left: 2px solid var(--accent);
}
.scope-track-tip {
  font-size: 10px; color: #3a6a40; padding: 4px 6px; margin-bottom: 5px;
  background: rgba(64,192,87,.05); border-radius: 4px; border-left: 2px solid #40c057;
}
.scope-repo-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 5px; margin-bottom: 3px; transition: background .12s;
}
.scope-repo-row:hover { background: var(--bg-hover); }
.scope-repo-dot {
  width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
}
.dot-blue  { background: var(--accent); }
.dot-green { background: #40c057; }
.scope-repo-text {
  flex: 1; font-size: 11px; color: #7b8cde;
  font-family: "SF Mono", Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.scope-repo-rm {
  background: none; border: none; color: var(--text-dim); font-size: 10px;
  cursor: pointer; padding: 1px 4px; border-radius: 3px; flex-shrink: 0; transition: all .12s;
}
.scope-repo-rm:hover { color: #e03131; background: rgba(224,49,49,.1); }

/* 添加区域 */
.scope-add-area { display: flex; gap: 5px; align-items: center; }
.scope-add-panel-btn {
  flex: 1; padding: 5px; background: transparent;
  border: 1px dashed var(--border); border-radius: 5px;
  font-size: 11px; color: var(--text-muted); cursor: pointer; transition: all .12s;
}
.scope-add-panel-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.scope-add-panel-btn:disabled { opacity: .5; cursor: not-allowed; }

/* 代码改动区块 */
.add-count { color: #40c057; }
.del-count { color: #e03131; }

.section-clickable { cursor: pointer; transition: background 0.12s; }
.section-clickable:hover { background: #1c1c26; }

.diff-summary {
  margin-left: auto;
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 600;
}
.diff-file-count { color: #3a3a55; font-weight: 400; }
.diff-open-hint  { color: #3a3a55; font-size: 12px; }

.artifact-category {
  font-size: 10px; font-weight: 700; margin: 8px 0 4px;
  display: flex; align-items: center; gap: 4px;
}
.report-cat { color: #7b8cde; }
.plan-cat   { color: #69d999; }

.artifact-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: 6px; cursor: pointer;
  border-left: 2px solid transparent; transition: all 0.12s;
  margin: 2px 0;
}
.artifact-item.artifact-md   { color: #7ba3f5; }
.artifact-item.artifact-html { color: #69d999; }
.artifact-item.artifact-md:hover   { background: var(--bg-surface); border-left-color: #3b5bdb; }
.artifact-item.artifact-html:hover { background: rgba(105,217,153,.06); border-left-color: #4cae7a; }

.artifact-icon { font-size: 13px; flex-shrink: 0; }
.artifact-name {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px;
}
.artifact-ext {
  font-size: 8px; font-weight: 700; letter-spacing: 0.06em;
  padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
}
.ext-md   { background: rgba(123,140,222,.12); color: #7b8cde; }
.ext-html { background: rgba(105,217,153,.1);  color: #69d999; }
.empty-hint { color: #444; font-style: italic; }
</style>
