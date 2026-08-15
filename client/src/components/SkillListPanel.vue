<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '../api/http.js';

const router = useRouter();
const skills = ref([]);
const SOURCE_LABEL = { default: '默认', user: '用户修改', mixed: '混合' };

async function load() {
  try { skills.value = await http.getSkills(); }
  catch (e) { console.error('加载技能失败', e); }
}

onMounted(load);
</script>

<template>
  <div class="skill-list">
    <div v-for="s in skills" :key="s.name" class="skill-card">
      <div class="skill-card-top">
        <div class="skill-icon">✦</div>
        <div class="skill-name">{{ s.name }}</div>
        <span class="ver-chip" :class="s.source">{{ SOURCE_LABEL[s.source] ?? s.source }}</span>
        <span class="skill-files">{{ s.fileCount }} 个文件</span>
      </div>
      <div class="skill-desc">{{ s.description || '（无描述）' }}</div>
      <div class="skill-card-actions">
        <button class="mini-btn" @click="router.push(`/skills/${s.name}`)">打开编辑器</button>
      </div>
      <!-- hover 浮层：全部描述 -->
      <div class="skill-pop">{{ s.description || '（无描述）' }}</div>
    </div>
    <div v-if="!skills.length" class="empty-hint">暂无技能</div>
  </div>
</template>

<style scoped>
.skill-list { padding: 12px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; height: 100%; }
.skill-card { position: relative; background: var(--bg-surface-3); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.skill-card:hover { border-color: var(--accent); }
.skill-card-top { display: flex; align-items: center; gap: 8px; }
.skill-icon { width: 26px; height: 26px; border-radius: 7px; background: rgba(59,91,219,.18); display: flex; align-items: center; justify-content: center; font-size: 13px; color: #8fa1e8; flex-shrink: 0; }
.skill-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ver-chip { font-size: 10px; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--border); color: var(--text-muted); }
.ver-chip.user { color: #f7b037; border-color: rgba(247,176,55,.4); }
.ver-chip.mixed { color: #b197fc; border-color: rgba(177,151,252,.35); }
.skill-files { font-size: 10px; color: var(--text-dim); margin-left: auto; }
.skill-desc { font-size: 11.5px; color: var(--text-muted); margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-card-actions { display: flex; gap: 6px; margin-top: 9px; }
.mini-btn { font-size: 10.5px; color: var(--text-muted); background: none; border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.mini-btn:hover { border-color: var(--accent); color: #8fa1e8; }
/* hover 浮层：简述截断时展示全部描述 */
.skill-pop { display: none; position: absolute; left: 10px; right: 10px; top: calc(100% - 4px); z-index: 5;
  background: var(--bg-surface); border: 1px solid var(--accent); border-radius: 10px; padding: 10px 12px;
  font-size: 11.5px; line-height: 1.6; color: var(--text-primary); box-shadow: 0 12px 32px rgba(0,0,0,.55);
  white-space: pre-wrap; }
.skill-card:hover .skill-pop { display: block; }
.empty-hint { color: var(--text-dim); font-style: italic; }
</style>
