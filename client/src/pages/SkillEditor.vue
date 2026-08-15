<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '../api/http.js';

const props = defineProps({ name: { type: String, required: true } });
const router = useRouter();

const tree        = ref([]);
const activePath  = ref('');
const content     = ref('');      // 编辑区内容
const savedContent = ref('');     // 已保存内容（脏标记对比）
const activeSource = ref('default');
const newFileName = ref('');
const renaming    = ref(false);
const renameTo    = ref('');
const error       = ref('');

const dirty = computed(() => content.value !== savedContent.value);
const SRC_LABEL = { default: '默', user: '用', new: '新' };

async function loadTree(selectFirst = true) {
  tree.value = await http.getSkillTree(props.name);
  if (selectFirst && tree.value.length && !activePath.value) openFile(tree.value[0].path);
}

async function openFile(p) {
  if (dirty.value && !confirm('当前文件有未保存修改，确定切换？')) return;
  try {
    const f = await http.getSkillFile(props.name, p);
    activePath.value = p;
    content.value = f.content;
    savedContent.value = f.content;
    activeSource.value = f.source;
    renaming.value = false;
    error.value = '';
  } catch (e) { error.value = e.message; }
}

async function save() {
  error.value = '';
  try {
    const f = await http.saveSkillFile(props.name, activePath.value, content.value);
    savedContent.value = f.content;
    activeSource.value = f.source;
    await loadTree(false);
  } catch (e) { error.value = e.message; }
}

async function resetToDefault() {
  if (!confirm(`恢复 ${activePath.value} 为默认版？用户修改将丢失。`)) return;
  try {
    await http.deleteSkillFile(props.name, activePath.value);
    const p = activePath.value;
    activePath.value = '';
    content.value = '';
    savedContent.value = '';
    error.value = '';
    await loadTree(false);
    await openFile(p);   // 默认版仍在则重开（成功路径会清 error）
    if (activePath.value !== p) error.value = '';   // source=new 删除后无默认版可回退：保持空态，不留 404
  } catch (e) { error.value = e.message; }
}

async function addFile() {
  const n = newFileName.value.trim();
  if (!n) return;
  if (!/^[\w-]+\.md$/.test(n)) { error.value = '文件名须为 xxx.md（字母数字-_）'; return; }
  error.value = '';
  try {
    await http.saveSkillFile(props.name, n, `# ${n.replace(/\.md$/, '')}\n`);
    newFileName.value = '';
    await loadTree(false);
    await openFile(n);
  } catch (e) { error.value = e.message; }
}

async function doRename() {
  const n = renameTo.value.trim();
  if (!n || n === activePath.value) { renaming.value = false; return; }
  if (!/^[\w-]+\.md$/.test(n)) { error.value = '文件名须为 xxx.md（字母数字-_）'; return; }
  try {
    await http.saveSkillFile(props.name, n, content.value);   // 改名 = 存新名 + 删旧名
    await http.deleteSkillFile(props.name, activePath.value);
    renaming.value = false;
    activePath.value = '';
    await loadTree(false);
    await openFile(n);
  } catch (e) { error.value = e.message; }
}

onMounted(() => loadTree());
</script>

<template>
  <div class="layout">
    <header class="editor-header">
      <button class="back-btn" @click="router.back()">← 返回</button>
      <span class="editor-title">技能 / {{ name }}</span>
      <span v-if="dirty" class="dirty-tag">● 未保存</span>
    </header>

    <div class="editor-body">
      <div class="file-tree">
        <div class="tree-title">文件</div>
        <div v-for="f in tree" :key="f.path" class="f-item" :class="{ active: f.path === activePath }"
             @click="openFile(f.path)">
          📄 {{ f.path }}
          <span class="f-src" :class="f.source">{{ SRC_LABEL[f.source] }}</span>
        </div>
        <div class="tree-add">
          <input v-model="newFileName" class="tree-input" placeholder="新文件.md" @keyup.enter="addFile" />
          <button class="mini-btn" @click="addFile">＋</button>
        </div>
      </div>

      <div class="file-view">
        <template v-if="activePath">
          <div class="file-view-head">
            <template v-if="renaming">
              <input v-model="renameTo" class="tree-input" @keyup.enter="doRename" />
              <button class="mini-btn" @click="doRename">确定</button>
              <button class="mini-btn" @click="renaming = false">取消</button>
            </template>
            <template v-else>
              <span class="file-name">{{ activePath }}</span>
              <span class="ver-chip" :class="activeSource">{{ { default: '默认版', user: '用户版', new: '用户新增' }[activeSource] }}</span>
            </template>
            <span class="head-spacer"></span>
            <button v-if="activeSource !== 'default'" class="mini-btn" @click="resetToDefault">
              {{ activeSource === 'new' ? '删除' : '恢复默认' }}
            </button>
            <button v-if="!renaming" class="mini-btn" @click="renameTo = activePath; renaming = true">改名</button>
            <button class="btn-save" :disabled="!dirty" @click="save">保存</button>
          </div>
          <textarea v-model="content" class="file-editor" spellcheck="false"></textarea>
          <div v-if="error" class="error-bar">{{ error }}</div>
          <div class="note">生效版 = 用户版文件覆盖默认版（文件粒度合并）。保存后立即生效（native 同步与 prompt 投递均用生效版）。</div>
        </template>
        <div v-else class="empty-hint">← 选择文件</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout { display: flex; flex-direction: column; height: 100vh; }
.editor-header { background: var(--bg-surface); border-bottom: 1px solid var(--border); padding: 0 20px; height: 52px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.back-btn { background: transparent; border: 1px solid var(--border); color: var(--text-muted); border-radius: 7px; padding: 5px 11px; font-size: 12px; cursor: pointer; }
.editor-title { font-size: 14px; font-weight: 700; color: var(--text-primary); }
.dirty-tag { font-size: 11px; color: #f7b037; }
.editor-body { flex: 1; display: flex; overflow: hidden; }
.file-tree { width: 220px; border-right: 1px solid var(--border); background: var(--bg-surface); padding: 10px 8px; display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
.tree-title { font-size: 10.5px; color: var(--text-dim); padding: 0 8px 8px; }
.f-item { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 6px 10px; border-radius: 7px; color: var(--text-muted); cursor: pointer; font-family: "SF Mono", Menlo, monospace; }
.f-item:hover { background: var(--bg-hover); }
.f-item.active { background: rgba(59,91,219,.15); color: var(--text-primary); }
.f-src { margin-left: auto; font-size: 9px; padding: 0 5px; border-radius: 4px; }
.f-src.default { color: var(--text-dim); background: var(--bg-surface-3); }
.f-src.user { color: #f7b037; background: rgba(247,176,55,.1); }
.f-src.new { color: #63e6be; background: rgba(99,230,190,.1); }
.tree-add { display: flex; gap: 4px; margin-top: 8px; padding: 0 4px; }
.tree-input { flex: 1; min-width: 0; background: var(--bg-surface-3); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 11px; color: var(--text-primary); outline: none; }
.file-view { flex: 1; display: flex; flex-direction: column; }
.file-view-head { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
.file-name { font-family: "SF Mono", Menlo, monospace; font-size: 12px; color: #8fa1e8; }
.head-spacer { flex: 1; }
.ver-chip { font-size: 10px; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--border); color: var(--text-muted); }
.ver-chip.user, .ver-chip.new { color: #f7b037; border-color: rgba(247,176,55,.4); }
.mini-btn { font-size: 11px; color: var(--text-muted); background: none; border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.btn-save { font-size: 11px; background: var(--accent); color: #fff; border: none; border-radius: 7px; padding: 4px 14px; cursor: pointer; }
.btn-save:disabled { opacity: .4; cursor: not-allowed; }
.file-editor { flex: 1; background: var(--bg-base); border: none; outline: none; resize: none; padding: 14px 18px; font-family: "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.7; color: var(--text-primary); }
.error-bar { padding: 6px 18px; font-size: 11px; color: #e03131; border-top: 1px solid var(--border); }
.note { font-size: 11px; color: var(--text-dim); padding: 8px 18px; border-top: 1px solid var(--border); }
.empty-hint { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
</style>
