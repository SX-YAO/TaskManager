<script setup>
import { ref, watch } from 'vue';
import { http } from '../api/http.js';
import BranchSelector from './BranchSelector.vue';

const emit = defineEmits(['close', 'created']);

const form = ref({ title: '', projectDir: '', purpose: '', agentType: 'claude',
                   dangerouslySkipPermissions: false, scopeEnabled: false, watchedRepos: [] });
const pickingScope   = ref(false);
const scopeBaseBranch = ref('master');  // 新添加时使用的基准分支

async function pickScopeDir() {
  pickingScope.value = true;
  try {
    const { path } = await http.pickDirectory();
    if (path && !form.value.watchedRepos.find(r => r.path === path)) {
      form.value.watchedRepos.push({ path, baseBranch: scopeBaseBranch.value || 'master' });
    }
  } catch { /* 取消 */ }
  finally { pickingScope.value = false; }
}

function removeScopeRepo(path) {
  form.value.watchedRepos = form.value.watchedRepos.filter(r => r.path !== path);
}
const loading  = ref(false);
const picking  = ref(false);
const error    = ref('');
const conflicts = ref([]); // 目录冲突的运行中任务

// 判断两个路径是否相同或互为父子（与后端逻辑保持一致）
function isConflict(a, b) {
  const na = a.replace(/\/+$/, '');
  const nb = b.replace(/\/+$/, '');
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

async function checkConflicts(dir) {
  if (!dir) { conflicts.value = []; return; }
  try {
    const tasks = await http.getTasks();
    conflicts.value = tasks.filter(
      t => t.status === 'running' && isConflict(t.projectDir, dir),
    );
  } catch {
    conflicts.value = [];
  }
}

// 选完目录后立即检查
watch(() => form.value.projectDir, (dir) => checkConflicts(dir));

async function pickDir() {
  picking.value = true;
  try {
    const { path } = await http.pickDirectory();
    form.value.projectDir = path;
    // watch 会自动触发 checkConflicts
  } catch {
    // 用户取消，保持现有值
  } finally {
    picking.value = false;
  }
}

async function submit() {
  if (!form.value.title || !form.value.projectDir || !form.value.purpose) {
    error.value = '请填写所有必填项';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const task = await http.createTask(form.value);
    emit('created', task);
    emit('close');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">

      <div class="modal-header">
        <div class="modal-title">新建任务</div>
        <button class="modal-close" @click="$emit('close')">✕</button>
      </div>

      <!-- 任务标题 -->
      <div class="form-group">
        <label class="form-label">任务标题 <span class="req">*</span></label>
        <input
          v-model="form.title"
          class="form-input"
          type="text"
          placeholder="例：CSC 退款流程重构"
        />
      </div>

      <!-- 项目目录 -->
      <div class="form-group">
        <label class="form-label">项目目录 <span class="req">*</span></label>
        <div class="dir-picker" :class="{ active: picking }" @click="pickDir">
          <span class="dir-picker-icon">📁</span>
          <span class="dir-picker-path" :class="{ placeholder: !form.projectDir }">
            {{ picking ? '选择中…' : (form.projectDir || '点击选择项目目录') }}
          </span>
          <span class="dir-picker-btn">选择 ›</span>
        </div>
      </div>

      <!-- 目录冲突软警告 -->
      <Transition name="slide">
        <div v-if="conflicts.length" class="conflict-warning">
          <span class="cw-icon">⚠️</span>
          <div class="cw-body">
            <div class="cw-title">目录冲突提醒</div>
            <div class="cw-desc">以下任务正在操作相同或相关目录，创建后 Agent 将主动向你确认冲突范围再开始改动：</div>
            <ul class="cw-list">
              <li v-for="t in conflicts" :key="t.id">· {{ t.title }}</li>
            </ul>
          </div>
        </div>
      </Transition>

      <!-- 任务目的 -->
      <div class="form-group">
        <label class="form-label">任务目的 <span class="req">*</span></label>
        <textarea
          v-model="form.purpose"
          class="form-textarea"
          placeholder="描述任务目标和验收标准，AI 会在每次会话开始时读取..."
        ></textarea>
      </div>

      <!-- Agent 选择 -->
      <div class="form-group">
        <label class="form-label">Agent</label>
        <div class="agent-selector">
          <div class="agent-option selected">
            <div class="agent-icon">✦</div>
            <div class="agent-name">Claude</div>
            <div class="agent-desc">Opus · 推荐</div>
          </div>
          <div class="agent-option disabled" title="即将支持">
            <div class="agent-icon">⬡</div>
            <div class="agent-name">GPT-4</div>
            <div class="agent-desc">即将支持</div>
          </div>
          <div class="agent-option disabled" title="即将支持">
            <div class="agent-icon">◈</div>
            <div class="agent-name">Gemini</div>
            <div class="agent-desc">即将支持</div>
          </div>
        </div>
      </div>

      <!-- 改动范围开关 -->
      <div class="scope-row" @click="form.scopeEnabled = !form.scopeEnabled">
        <div class="scope-left">
          <div class="scope-label">圈定改动范围</div>
          <div class="scope-hint">适用于多项目仓库 · 开启后 AI 不会修改指定范围外的文件（读取不受限）</div>
        </div>
        <div class="toggle" :class="{ on: form.scopeEnabled }">
          <div class="toggle-thumb"></div>
        </div>
      </div>

      <!-- 改动范围 repo 列表（仅 scopeEnabled 时展示） -->
      <Transition name="slide">
        <div v-if="form.scopeEnabled" class="scope-repos">
          <div class="scope-repos-hint">
            AI <strong>写入操作</strong>的边界目录（读取任意目录不受限）
          </div>
          <div v-for="repo in form.watchedRepos" :key="repo.path" class="scope-repo-item">
            <span class="scope-repo-icon">📦</span>
            <span class="scope-repo-name" :title="repo.path">{{ repo.path.replace(/\/+$/, '').split('/').pop() }}</span>
            <!-- BranchSelector：为已添加的 repo 修改对比分支 -->
            <BranchSelector
              :model-value="repo.baseBranch"
              :repo-path="repo.path"
              @update:model-value="repo.baseBranch = $event"
            />
            <button class="scope-repo-del" @click.stop="removeScopeRepo(repo.path)">✕</button>
          </div>
          <!-- 基准分支 + 添加按钮 -->
          <div class="scope-add-row">
            <BranchSelector
              v-model="scopeBaseBranch"
              repo-path=""
              placeholder="对比分支"
            />
            <button class="scope-add-btn" :disabled="pickingScope" @click.stop="pickScopeDir">
              {{ pickingScope ? '选择中…' : '＋ 选择目录' }}
            </button>
          </div>
        </div>
      </Transition>

      <!-- 危险模式 -->
      <div class="danger-row" @click="form.dangerouslySkipPermissions = !form.dangerouslySkipPermissions">
        <div class="danger-left">
          <span class="danger-icon">⚠️</span>
          <div>
            <div class="danger-label">危险模式</div>
            <div class="danger-hint">跳过所有权限检查（--dangerously-skip-permissions）</div>
          </div>
        </div>
        <div class="toggle" :class="{ on: form.dangerouslySkipPermissions }">
          <div class="toggle-thumb"></div>
        </div>
      </div>

      <p v-if="error" class="error-msg">{{ error }}</p>

      <div class="modal-footer">
        <button class="btn-secondary" @click="$emit('close')">取消</button>
        <button class="btn-primary" :disabled="loading" @click="submit">
          {{ loading ? '创建中…' : '创建任务 →' }}
        </button>
      </div>

    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
  backdrop-filter: blur(4px);
}

.modal {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: 520px;
  max-width: 90vw;
  padding: 28px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
}

/* ── 头部 ── */
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 24px;
}
.modal-title { font-size: 16px; font-weight: 700; color: var(--text-primary); }
.modal-close {
  background: transparent; border: none; color: #555;
  font-size: 18px; cursor: pointer; padding: 2px 6px; border-radius: 4px;
  transition: color 0.12s, background 0.12s;
}
.modal-close:hover { color: #888; background: #2a2a38; }

/* ── 表单 ── */
.form-group { margin-bottom: 18px; }

.form-label {
  display: block; font-size: 12px; font-weight: 600;
  color: #666; margin-bottom: 6px;
}
.req { color: #e06060; }

.form-input {
  width: 100%; background: var(--bg-base); border: 1px solid var(--border);
  border-radius: 9px; padding: 10px 14px; color: var(--text-primary);
  font-size: 13px; font-family: inherit; outline: none;
  transition: border-color 0.15s;
}
.form-input:focus { border-color: #3b5bdb; }
.form-input::placeholder { color: #333; }

.form-textarea {
  width: 100%; background: var(--bg-base); border: 1px solid var(--border);
  border-radius: 9px; padding: 10px 14px; color: var(--text-primary);
  font-size: 13px; font-family: inherit; resize: vertical;
  min-height: 80px; outline: none;
  transition: border-color 0.15s; line-height: 1.5;
}
.form-textarea:focus { border-color: #3b5bdb; }
.form-textarea::placeholder { color: #333; }

/* ── 目录选择 ── */
.dir-picker {
  width: 100%; background: var(--bg-base); border: 1px solid var(--border);
  border-radius: 9px; padding: 10px 14px; color: var(--text-primary);
  font-size: 13px; cursor: pointer;
  display: flex; align-items: center; gap: 10px;
  transition: border-color 0.15s;
  user-select: none;
}
.dir-picker:hover, .dir-picker.active { border-color: #3b5bdb; }

.dir-picker-icon { font-size: 14px; color: #444; flex-shrink: 0; }

.dir-picker-path {
  flex: 1;
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px; color: #7b8cde;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dir-picker-path.placeholder { color: #444; font-family: inherit; font-size: 13px; }

.dir-picker-btn { font-size: 12px; color: #444; flex-shrink: 0; }

/* ── Agent 选择器 ── */
.agent-selector { display: flex; gap: 8px; }

.agent-option {
  flex: 1;
  border: 1.5px solid #2a2a38;
  border-radius: 9px; padding: 10px;
  cursor: pointer; text-align: center;
  transition: border-color 0.15s, background 0.15s;
}
.agent-option.selected {
  border-color: #3b5bdb;
  background: rgba(59, 91, 219, 0.08);
}
.agent-option.disabled { opacity: 0.35; cursor: not-allowed; }

.agent-icon { font-size: 20px; margin-bottom: 4px; }
.agent-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.agent-desc { font-size: 10px; color: #555; margin-top: 2px; }

/* ── 底部 ── */
/* 冲突警告 */
.conflict-warning {
  display: flex; gap: 10px;
  background: rgba(193,119,0,0.08);
  border: 1px solid rgba(193,119,0,0.3);
  border-radius: 9px; padding: 12px 14px;
  margin-bottom: 18px;
}
.cw-icon { font-size: 16px; flex-shrink: 0; line-height: 1.5; }
.cw-body { flex: 1; min-width: 0; }
.cw-title { font-size: 12px; font-weight: 700; color: #e8a820; margin-bottom: 4px; }
.cw-desc  { font-size: 12px; color: #a07830; line-height: 1.5; margin-bottom: 6px; }
.cw-list  { padding: 0; list-style: none; }
.cw-list li { font-size: 12px; color: #c09040; line-height: 1.6; }

.slide-enter-active, .slide-leave-active {
  transition: all 0.2s ease;
  overflow: hidden;
}
.slide-enter-from, .slide-leave-to {
  opacity: 0;
  max-height: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
}
.slide-enter-to, .slide-leave-from { max-height: 300px; }

/* 改动范围开关行 */
.scope-row {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--bg-base); border: 1px solid var(--border); border-radius: 9px;
  padding: 10px 14px; margin-bottom: 10px; cursor: pointer;
  transition: border-color 0.15s; user-select: none;
}
.scope-row:hover { border-color: var(--accent); }
.scope-left { flex: 1; }
.scope-label { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.scope-hint  { font-size: 11px; color: var(--text-muted); margin-top: 2px; line-height: 1.5; }

/* 改动范围 repo 列表 */
.scope-repos {
  background: var(--bg-base); border: 1px solid var(--border-sub);
  border-radius: 9px; padding: 10px 12px; margin-bottom: 16px;
}
.scope-repos-hint {
  font-size: 11px; color: #2a3a6a; margin-bottom: 8px; line-height: 1.6;
  background: rgba(59,91,219,.05); border-radius: 5px; padding: 5px 8px;
}
.scope-repos-hint strong { color: var(--accent); }
.scope-repo-item {
  display: flex; align-items: center; gap: 7px;
  background: var(--bg-surface); border: 1px solid var(--border-sub); border-radius: 6px;
  padding: 6px 10px; margin-bottom: 5px;
}
.scope-repo-icon { font-size: 13px; flex-shrink: 0; }
.scope-repo-name {
  flex: 1; font-size: 12px; color: #7b8cde; font-family: "SF Mono", Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.scope-repo-del {
  background: transparent; border: none; color: var(--text-dim); font-size: 11px;
  cursor: pointer; padding: 1px 4px; border-radius: 3px; transition: all .12s;
}
.scope-repo-del:hover { color: #e03131; background: rgba(224,49,49,.1); }
.scope-add-row { display: flex; gap: 6px; align-items: center; }
.scope-add-btn {
  flex: 1; padding: 7px; background: transparent;
  border: 1px dashed var(--border); border-radius: 6px;
  font-size: 12px; color: var(--text-muted); cursor: pointer; transition: all .12s;
}
.scope-add-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.scope-add-btn:disabled { opacity: .6; cursor: not-allowed; }

/* toggle 开关颜色：改动范围用蓝色 */
.scope-row .toggle.on { background: var(--accent); }

/* 危险模式开关行 */
.danger-row {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--bg-base); border: 1px solid var(--border); border-radius: 9px;
  padding: 10px 14px; margin-bottom: 18px; cursor: pointer;
  transition: border-color 0.15s;
  user-select: none;
}
.danger-row:hover { border-color: #c17700; }

.danger-left { display: flex; align-items: center; gap: 10px; }
.danger-icon { font-size: 16px; flex-shrink: 0; }
.danger-label { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.danger-hint { font-size: 11px; color: #555; margin-top: 2px; font-family: "SF Mono", Menlo, monospace; }

/* Toggle 开关 */
.toggle {
  width: 36px; height: 20px; border-radius: 10px;
  background: #2a2a38; flex-shrink: 0;
  position: relative; transition: background 0.2s;
}
.toggle.on { background: #c17700; }
.toggle-thumb {
  position: absolute; top: 3px; left: 3px;
  width: 14px; height: 14px; border-radius: 50%;
  background: white; transition: transform 0.2s;
}
.toggle.on .toggle-thumb { transform: translateX(16px); }

.error-msg { color: #e06060; font-size: 13px; margin-bottom: 12px; }

.modal-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  margin-top: 24px; padding-top: 18px;
  border-top: 1px solid var(--border);
}

.btn-secondary {
  padding: 8px 18px; background: transparent;
  border: 1px solid var(--border); color: #888;
  border-radius: 8px; font-size: 13px; cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.btn-secondary:hover { border-color: #444; color: #ccc; }

.btn-primary {
  padding: 8px 20px; background: #3b5bdb; border: none;
  color: white; border-radius: 8px; font-size: 13px;
  font-weight: 500; cursor: pointer;
  transition: background 0.12s;
}
.btn-primary:hover:not(:disabled) { background: #4c6ef5; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
