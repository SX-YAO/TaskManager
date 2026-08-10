<script setup>
import { provide, onMounted, onUnmounted } from 'vue';
import { offline, markOffline, markOnline } from './composables/useServiceState.js';
import { useTheme } from './composables/useTheme.js';

// 初始化主题（applyTheme 在 useTheme.js 导入时已自动调用）
useTheme();

provide('setOffline',   markOffline);
provide('serverOnline', offline);

// 心跳：服务在线时不轮询；离线后每 3s 检测是否恢复
let timer = null;

onMounted(() => {
  timer = setInterval(async () => {
    if (!offline.value) return;
    try {
      const res = await fetch('/api/status', { signal: AbortSignal.timeout(2000) });
      if (res.ok) markOnline();
    } catch { /* 仍离线 */ }
  }, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <router-view />

  <Transition name="fade">
    <div v-if="offline" class="offline-overlay">
      <div class="offline-card">
        <div class="offline-icon">⏻</div>
        <div class="offline-title">服务已关闭</div>
        <div class="offline-desc">
          后端服务已停止运行。<br/>
          双击 <code>start.command</code> 或执行 <code>npm run dev</code> 重新启动。
        </div>
      </div>
    </div>
  </Transition>
</template>

<style>
/* ── 深色主题（默认）── */
:root, [data-theme="dark"] {
  --bg-base:      #0f0f13;
  --bg-surface:   #1a1a24;
  --bg-surface-2: #13131a;
  --bg-surface-3: #111118;
  --bg-input:     #0f0f13;
  --bg-hover:     #1e1e2a;

  --border:       #2a2a38;
  --border-sub:   #1e1e2a;
  --border-dim:   #141420;

  --text-primary:   #e8e8f0;
  --text-secondary: #c8c8d8;
  --text-muted:     #555570;
  --text-dim:       #333344;
  --text-placeholder: #2a2a38;

  --accent:       #3b5bdb;
  --accent-hover: #4c6ef5;
  --accent-sub:   rgba(59,91,219,0.12);

  --scrollbar-thumb: #2a2a38;

  color-scheme: dark;
}

/* ── 浅色主题 ── */
[data-theme="light"] {
  --bg-base:      #f2f2f7;
  --bg-surface:   #ffffff;
  --bg-surface-2: #f8f8fc;
  --bg-surface-3: #f0f0f5;
  --bg-input:     #ffffff;
  --bg-hover:     #f0f0f8;

  --border:       #d8d8e8;
  --border-sub:   #e4e4f0;
  --border-dim:   #ebebf5;

  --text-primary:   #1a1a2e;
  --text-secondary: #2e2e48;
  --text-muted:     #606080;
  --text-dim:       #9090a8;
  --text-placeholder: #b0b0c8;

  --accent:       #3b5bdb;
  --accent-hover: #4c6ef5;
  --accent-sub:   rgba(59,91,219,0.08);

  --scrollbar-thumb: #c8c8d8;

  color-scheme: light;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  background: var(--bg-base); color: var(--text-primary);
  height: 100vh; overflow: hidden;
  transition: background 0.2s, color 0.2s;
}
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
</style>

<style scoped>
.offline-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(10,10,16,0.92); backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
}
.offline-card {
  background: var(--bg-surface); border: 1px solid var(--border);
  border-radius: 20px; padding: 40px 48px;
  text-align: center; box-shadow: 0 32px 80px rgba(0,0,0,0.6);
  min-width: 300px;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
}
.offline-icon { font-size: 40px; color: #444; line-height: 1; }
.offline-title { font-size: 18px; font-weight: 700; color: #e8e8f0; }
.offline-desc { font-size: 13px; color: #555570; line-height: 1.9; }
.offline-desc code {
  color: #7b8cde; font-family: "SF Mono", Menlo, monospace;
  font-size: 11px; background: #1e2030; padding: 2px 6px; border-radius: 4px;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
