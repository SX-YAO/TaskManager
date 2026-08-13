<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '../api/http.js';
import { offline, markOffline } from '../composables/useServiceState.js';
import { useTheme } from '../composables/useTheme.js';

const { theme, toggle: toggleTheme } = useTheme();
import TaskCard from '../components/TaskCard.vue';
import NewTaskModal from '../components/NewTaskModal.vue';

const router       = useRouter();
const serverOnline = computed(() => !offline.value);

const tasks               = ref([]);
const showModal           = ref(false);
const showShutdownConfirm = ref(false);
const shutting            = ref(false);

// 删除确认弹窗状态
const deleteTarget = ref(null);   // 当前待删除的 task 对象
const deleting     = ref(false);

async function loadTasks() {
  try { tasks.value = await http.getTasks(); } catch (e) { console.error(e); }
}

function onCreated(task) {
  tasks.value.unshift(task);
  router.push(`/task/${task.id}`);
}

function onDeleteRequest(task) {
  deleteTarget.value = task;
}

async function doArchive() {
  if (!deleteTarget.value || deleting.value) return;
  deleting.value = true;
  try {
    await http.archiveTask(deleteTarget.value.id);
    tasks.value = tasks.value.filter(t => t.id !== deleteTarget.value.id);
    deleteTarget.value = null;
  } catch (e) { console.error(e); }
  finally { deleting.value = false; }
}

async function doDelete() {
  if (!deleteTarget.value || deleting.value) return;
  deleting.value = true;
  try {
    await http.deleteTask(deleteTarget.value.id);
    tasks.value = tasks.value.filter(t => t.id !== deleteTarget.value.id);
    deleteTarget.value = null;
  } catch (e) { console.error(e); }
  finally { deleting.value = false; }
}

async function confirmShutdown() {
  shutting.value = true;
  try {
    await http.shutdown();
  } catch { /* 关闭时连接断开属正常 */ } finally {
    markOffline();
    showShutdownConfirm.value = false;
    shutting.value = false;
  }
}

onMounted(loadTasks);
</script>

<template>
  <div class="layout">
    <header class="app-header">
      <div class="logo">
        <div class="logo-icon">✦</div>
        Task Manager
        <!-- 服务状态指示点 -->
        <span class="status-dot" :class="serverOnline ? 'online' : 'offline'" :title="serverOnline ? '服务在线' : '服务离线'"></span>
      </div>
      <div class="header-right">
        <button class="btn-icon" :title="theme === 'dark' ? '切换浅色模式' : '切换深色模式'" @click="toggleTheme">
          {{ theme === 'dark' ? '☀️' : '🌙' }}
        </button>
        <button class="btn-icon" title="设置" @click="router.push('/settings')">⚙</button>
        <button class="btn-icon danger" title="关闭服务" @click="showShutdownConfirm = true">⏻</button>
      </div>
    </header>

    <main class="grid-area">
      <div v-if="!tasks.length" class="empty">暂无任务，点击「新建任务」开始</div>
      <div class="grid">
        <div v-for="task in tasks" :key="task.id" @click="router.push(`/task/${task.id}`)">
          <TaskCard :task="task" @delete="onDeleteRequest" />
        </div>
        <div class="card-new" @click="showModal = true">
          <span class="plus">＋</span>
          <span>新建任务</span>
        </div>
      </div>
    </main>

    <!-- FAB -->
    <button class="fab" @click="showModal = true">
      <span class="fab-icon">＋</span>
      新建任务
    </button>

    <NewTaskModal v-if="showModal" @close="showModal = false" @created="onCreated" />

    <!-- 删除确认弹窗 -->
    <Transition name="fade">
      <div v-if="deleteTarget" class="confirm-overlay" @click.self="deleteTarget = null">
        <div class="confirm-card">
          <div class="confirm-title">删除任务</div>
          <div class="confirm-task-name">「{{ deleteTarget.title }}」</div>
          <div class="confirm-desc">选择删除方式：</div>

          <div class="delete-options">
            <button class="opt-archive" :disabled="deleting" @click="doArchive">
              <span class="opt-icon">📦</span>
              <div>
                <div class="opt-name">归档</div>
                <div class="opt-hint">保留所有数据，从列表中隐藏</div>
              </div>
            </button>
            <button class="opt-delete" :disabled="deleting" @click="doDelete">
              <span class="opt-icon">🗑</span>
              <div>
                <div class="opt-name">彻底删除</div>
                <div class="opt-hint">清除所有文件，不可恢复（适合测试会话）</div>
              </div>
            </button>
          </div>

          <button class="btn-cancel-delete" :disabled="deleting" @click="deleteTarget = null">取消</button>
        </div>
      </div>
    </Transition>

    <!-- 关闭服务确认框 -->
    <Transition name="fade">
      <div v-if="showShutdownConfirm" class="confirm-overlay" @click.self="showShutdownConfirm = false">
        <div class="confirm-card">
          <div class="confirm-icon">⏻</div>
          <div class="confirm-title">关闭服务？</div>
          <div class="confirm-desc-sm">后端服务将停止，所有进行中的 Agent 会话会中断。</div>
          <div class="confirm-actions">
            <button class="btn-cancel-delete" :disabled="shutting" @click="showShutdownConfirm = false">取消</button>
            <button class="btn-shutdown" :disabled="shutting" @click="confirmShutdown">
              {{ shutting ? '关闭中…' : '确认关闭' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.layout { display: flex; flex-direction: column; height: 100vh; position: relative; }

.app-header {
  background: var(--bg-surface); border-bottom: 1px solid var(--border);
  padding: 0 28px; height: 52px;
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
}
.logo {
  display: flex; align-items: center; gap: 8px;
  font-size: 15px; font-weight: 700;
}
.logo-icon {
  width: 26px; height: 26px; border-radius: 7px;
  background: linear-gradient(135deg, #3b5bdb, #7048e8);
  display: flex; align-items: center; justify-content: center; font-size: 13px;
}

/* 服务状态指示点 */
.status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  transition: background 0.3s;
}
.status-dot.online  { background: #40c057; box-shadow: 0 0 5px rgba(64,192,87,0.5); }
.status-dot.offline { background: #555; }

.header-right { display: flex; align-items: center; gap: 8px; }

/* FAB 悬浮新建按钮 */
.fab {
  position: fixed; bottom: 28px; right: 28px;
  height: 44px; padding: 0 20px;
  background: #3b5bdb; border: none; border-radius: 12px;
  color: white; font-size: 13px; font-weight: 500; cursor: pointer;
  display: flex; align-items: center; gap: 8px;
  box-shadow: 0 8px 24px rgba(59,91,219,.45);
  transition: background 0.12s, transform 0.12s, box-shadow 0.12s;
  z-index: 100;
}
.fab:hover {
  background: #4c6ef5; transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(59,91,219,.55);
}
.fab-icon { font-size: 18px; font-weight: 300; line-height: 1; }

/* 通用图标按钮（重启 / 关闭） */
.btn-icon {
  width: 34px; height: 34px;
  background: transparent; border: 1px solid var(--border);
  border-radius: 8px; color: #555; font-size: 16px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.btn-icon:hover       { border-color: #3b5bdb; color: #7b8cde; background: rgba(59,91,219,0.06); }
.btn-icon.danger:hover { border-color: #c92a2a; color: #e03131; background: rgba(224,49,49,0.06); }

.grid-area { flex: 1; overflow-y: auto; padding: 24px 28px; }
.empty { color: #555; font-size: 14px; padding: 40px 0; }
/* 卡片列宽固定，所有卡片宽高一致 */
.grid { display: grid; grid-template-columns: repeat(auto-fill, 260px); gap: 14px; }

.card-new {
  border: 1.5px dashed #2a2a38; border-radius: 12px; padding: 18px;
  height: 232px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px;
  cursor: pointer; font-size: 12px; color: #444;
  transition: border-color 0.15s, color 0.15s;
  box-sizing: border-box;
}
.card-new:hover { border-color: #3b5bdb; color: #3b5bdb; }
.plus { font-size: 22px; }

/* 弹窗 */
.confirm-overlay {
  position: fixed; inset: 0; z-index: 300;
  background: rgba(10,10,16,0.78);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
}

.confirm-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 16px; padding: 28px 28px 24px;
  width: 400px; max-width: 92vw;
  box-shadow: 0 24px 60px rgba(0,0,0,0.6);
}

.confirm-icon { font-size: 28px; color: #e03131; margin-bottom: 12px; text-align: center; }
.confirm-title { font-size: 15px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px; }
.confirm-task-name { font-size: 13px; color: #7b8cde; margin-bottom: 16px; }
.confirm-desc { font-size: 12px; color: #555; margin-bottom: 12px; }
.confirm-desc-sm { font-size: 13px; color: #666; line-height: 1.6; margin: 8px 0 20px; text-align: center; }

/* 两个删除选项按钮 */
.delete-options { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }

.opt-archive, .opt-delete {
  display: flex; align-items: center; gap: 14px;
  width: 100%; padding: 12px 14px;
  background: var(--bg-surface-3); border-radius: 10px;
  cursor: pointer; text-align: left;
  transition: border-color 0.12s, background 0.12s;
}
.opt-archive { border: 1px solid var(--border); }
.opt-delete  { border: 1px solid var(--border); }
.opt-archive:hover:not(:disabled) { border-color: #4c6ef5; background: rgba(59,91,219,0.06); }
.opt-delete:hover:not(:disabled)  { border-color: #c92a2a; background: rgba(224,49,49,0.06); }
.opt-archive:disabled, .opt-delete:disabled { opacity: 0.5; cursor: not-allowed; }

.opt-icon { font-size: 22px; flex-shrink: 0; }
.opt-name { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
.opt-hint { font-size: 11px; color: #555; line-height: 1.4; }

.btn-cancel-delete {
  width: 100%; padding: 9px;
  background: transparent; border: 1px solid var(--border); color: #666;
  border-radius: 8px; font-size: 13px; cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.btn-cancel-delete:hover:not(:disabled) { border-color: #444; color: #aaa; }
.btn-cancel-delete:disabled { opacity: 0.5; cursor: not-allowed; }

.confirm-actions { display: flex; gap: 10px; justify-content: flex-end; }

.btn-shutdown {
  padding: 8px 20px; background: #c92a2a; border: none;
  color: white; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background 0.12s;
}
.btn-shutdown:hover:not(:disabled) { background: #e03131; }
.btn-shutdown:disabled { opacity: 0.5; cursor: not-allowed; }


.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
