<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useTheme } from '../composables/useTheme.js';

const { theme, toggle: toggleTheme } = useTheme();
import { http } from '../api/http.js';

const router = useRouter();

// ── 数据 ────────────────────────────────────────────────────
const activeTab = ref('info');

const config   = ref(null);   // { command, version, configPath }
const settings = ref(null);   // { permissions: { allow, deny }, hooks }
const plugins  = ref([]);
const skills   = ref([]);

const loading   = ref(false);
const addingPerm = ref(false);

// ── 权限缺失检测 ────────────────────────────────────────────
const REQUIRED_PERM = 'Write(.task-manager/**)';

const tabs = [
  { key: 'info',    label: '基本信息' },
  { key: 'perm',    label: '权限'     },
  { key: 'plugins', label: '插件'     },
  { key: 'hooks',   label: 'Hooks'    },
  { key: 'skills',  label: '技能'     },
];

const permAllow  = computed(() => settings.value?.permissions?.allow ?? []);
const permDeny   = computed(() => settings.value?.permissions?.deny  ?? []);
const permMissing = computed(() => !permAllow.value.includes(REQUIRED_PERM));

// hooks 按类型分组
const hookGroups = computed(() => {
  const hooks = settings.value?.hooks ?? {};
  return Object.entries(hooks).map(([type, items]) => ({
    type,
    items: Array.isArray(items) ? items : [items],
  }));
});

// ── 数据加载 ────────────────────────────────────────────────
async function load() {
  loading.value = true;
  try {
    const [cfgRes, setRes, plugRes, skillRes] = await Promise.all([
      http.getClaudeConfig(),
      http.getClaudeSettings(),
      http.getClaudePlugins(),
      http.getClaudeSkills(),
    ]);
    config.value   = cfgRes;
    settings.value = setRes;
    plugins.value  = plugRes;
    skills.value   = skillRes;
  } catch (e) {
    console.error('加载 Claude 配置失败', e);
  } finally {
    loading.value = false;
  }
}

// ── 一键添加权限 ────────────────────────────────────────────
async function addPermission() {
  if (addingPerm.value) return;
  addingPerm.value = true;
  try {
    const res = await http.addClaudePermission(REQUIRED_PERM);
    // 更新本地 allow 列表
    if (settings.value) settings.value.permissions.allow = res.allow;
  } catch (e) {
    console.error('添加权限失败', e);
  } finally {
    addingPerm.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="layout">
    <!-- ── Header ─────────────────────────────────────────── -->
    <header class="app-header">
      <div class="logo" @click="router.push('/')">
        <div class="logo-icon">✦</div>
        Task Manager
      </div>
      <div class="header-right">
        <button class="btn-new" @click="router.push('/')">← 返回任务列表</button>
        <button class="btn-icon" :title="theme === 'dark' ? '切换浅色模式' : '切换深色模式'" @click="toggleTheme">
          {{ theme === 'dark' ? '☀️' : '🌙' }}
        </button>
        <button class="btn-icon btn-settings active-settings" title="设置">⚙</button>
      </div>
    </header>

    <!-- ── 主体：左导航 + 右内容 ─────────────────────────── -->
    <div class="settings-layout">

      <!-- 左侧导航 -->
      <nav class="settings-nav">
        <div class="nav-group">
          <div class="nav-group-title">Agent</div>
          <div class="nav-item active">
            <span class="nav-icon">✦</span>
            Claude
            <span v-if="permMissing && settings" class="nav-badge">⚠</span>
          </div>
        </div>
      </nav>

      <!-- 右侧内容 -->
      <div class="settings-content">

        <!-- 面包屑 -->
        <div class="breadcrumb">
          <span class="crumb link" @click="router.push('/')">设置</span>
          <span class="sep">›</span>
          <span class="crumb">Agent</span>
          <span class="sep">›</span>
          <span class="crumb current">Claude</span>
        </div>

        <!-- 页面标题 -->
        <div class="page-header">
          <div class="page-title">Claude</div>
          <div class="page-desc">查看 Claude CLI 的运行配置、权限、插件、Hooks 及可用技能</div>
        </div>

        <!-- Tab 栏 -->
        <div class="tab-bar">
          <button
            v-for="tab in tabs" :key="tab.key"
            class="tab-btn"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
            <span v-if="tab.key === 'perm' && permMissing && settings" class="tab-warn">⚠ 1</span>
          </button>
        </div>

        <!-- Tab 内容区 -->
        <div v-if="loading" class="loading">加载中…</div>
        <div v-else class="tab-panels">

          <!-- ① 基本信息 -->
          <div v-show="activeTab === 'info'" class="tab-panel">
            <div v-if="config" class="info-grid">
              <div class="info-card">
                <div class="info-label">命令</div>
                <div class="info-value highlight">{{ config.command }}</div>
              </div>
              <div class="info-card">
                <div class="info-label">版本</div>
                <div class="info-value">{{ config.version }}</div>
              </div>
              <div class="info-card span2">
                <div class="info-label">配置文件</div>
                <div class="info-value">{{ config.configPath }}</div>
              </div>
            </div>
          </div>

          <!-- ② 权限 -->
          <div v-show="activeTab === 'perm'" class="tab-panel">
            <!-- 缺失警告 -->
            <div v-if="permMissing" class="perm-warning">
              <div class="pw-icon">⚠️</div>
              <div class="pw-body">
                <div class="pw-title">缺少必要权限：{{ REQUIRED_PERM }}</div>
                <div class="pw-desc">
                  Claude 需要此权限才能自主写入 <code>.task-manager/</code> 下的进度和踩坑日记。<br/>
                  缺少时每次写文件都会触发确认弹窗，影响自动化流程。
                </div>
                <button
                  class="btn-fix"
                  :disabled="addingPerm"
                  @click="addPermission"
                >
                  {{ addingPerm ? '添加中…' : '+ 一键添加权限' }}
                </button>
              </div>
            </div>

            <!-- Allow 列表 -->
            <div class="perm-section-title">Allow</div>
            <div class="perm-list">
              <div
                v-for="p in permAllow" :key="p"
                class="perm-item"
                :class="p === REQUIRED_PERM ? 'ok' : 'ok'"
              >
                <span class="perm-type type-allow">Allow</span>
                <span class="perm-pattern">{{ p }}</span>
                <span class="perm-check">✓</span>
              </div>
              <div v-if="permMissing" class="perm-item missing">
                <span class="perm-type type-allow">Allow</span>
                <span class="perm-pattern warn">{{ REQUIRED_PERM }}</span>
                <span class="perm-missing-label">⚠ 缺失</span>
              </div>
              <div v-if="!permAllow.length && !permMissing" class="perm-empty">暂无</div>
            </div>

            <!-- Deny 列表 -->
            <div class="perm-section-title">Deny</div>
            <div class="perm-list">
              <div v-for="p in permDeny" :key="p" class="perm-item">
                <span class="perm-type type-deny">Deny</span>
                <span class="perm-pattern">{{ p }}</span>
              </div>
              <div v-if="!permDeny.length" class="perm-empty">暂无</div>
            </div>
          </div>

          <!-- ③ 插件 -->
          <div v-show="activeTab === 'plugins'" class="tab-panel">
            <div v-if="plugins.length" class="plugin-list">
              <div v-for="p in plugins" :key="p.name" class="plugin-card">
                <div class="plugin-logo">{{ p.name[0].toUpperCase() }}</div>
                <div class="plugin-info">
                  <div class="plugin-name">{{ p.name }}</div>
                  <div class="plugin-meta">
                    {{ [p.version && `v${p.version}`, p.source, p.skillCount && `${p.skillCount} 技能`].filter(Boolean).join(' · ') }}
                  </div>
                </div>
                <span class="plugin-status" :class="p.enabled ? 'status-on' : 'status-off'">
                  {{ p.enabled ? '已启用' : '未启用' }}
                </span>
              </div>
            </div>
            <div v-else class="perm-empty">未检测到已安装插件</div>
          </div>

          <!-- ④ Hooks -->
          <div v-show="activeTab === 'hooks'" class="tab-panel">
            <div v-if="hookGroups.length">
              <div v-for="group in hookGroups" :key="group.type" class="hook-group">
                <div class="hook-group-label">{{ group.type }}</div>
                <div v-for="(item, i) in group.items" :key="i" class="hook-card">
                  <div class="hook-matcher">{{ item.matcher ? `matcher: ${item.matcher}` : '（无 matcher，全局触发）' }}</div>
                  <div class="hook-cmd">{{ item.command ?? item.type ?? JSON.stringify(item) }}</div>
                </div>
              </div>
            </div>
            <div v-else class="perm-empty">暂无 Hooks 配置</div>
          </div>

          <!-- ⑤ 技能 -->
          <div v-show="activeTab === 'skills'" class="tab-panel">
            <div v-if="skills.length" class="skill-grid">
              <div v-for="s in skills" :key="s.name" class="skill-card">
                <div class="skill-name">{{ s.name }}</div>
                <div class="skill-desc">{{ s.description || '—' }}</div>
              </div>
            </div>
            <div v-else class="perm-empty">未检测到可用技能</div>
          </div>

        </div><!-- /tab-panels -->
      </div><!-- /settings-content -->
    </div><!-- /settings-layout -->
  </div>
</template>

<style scoped>
/* ── 整体布局 ────────────────────────────────────────────── */
.layout { display: flex; flex-direction: column; height: 100vh; }

/* ── Header ──────────────────────────────────────────────── */
.app-header {
  background: var(--bg-surface); border-bottom: 1px solid var(--border);
  padding: 0 24px; height: 52px; flex-shrink: 0;
  display: flex; align-items: center; gap: 12px;
}
.logo {
  display: flex; align-items: center; gap: 8px;
  font-size: 15px; font-weight: 700; cursor: pointer;
}
.logo-icon {
  width: 26px; height: 26px; border-radius: 7px;
  background: linear-gradient(135deg, #3b5bdb, #7048e8);
  display: flex; align-items: center; justify-content: center; font-size: 13px;
}
.header-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.btn-new {
  padding: 7px 14px; background: transparent; border: 1px solid var(--border);
  color: #888; border-radius: 8px; font-size: 13px; cursor: pointer;
  transition: all 0.12s;
}
.btn-new:hover { border-color: #444; color: #ccc; }
.btn-icon {
  width: 34px; height: 34px; background: transparent;
  border: 1px solid var(--border); border-radius: 8px;
  color: #555; font-size: 15px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.12s;
}
.btn-icon.active-settings {
  background: rgba(59,91,219,0.15); border-color: #3b5bdb; color: #7b8cde;
}

/* ── 双栏主体 ────────────────────────────────────────────── */
.settings-layout { flex: 1; display: flex; overflow: hidden; }

/* 左侧导航 */
.settings-nav {
  width: 200px; flex-shrink: 0;
  background: #141418; border-right: 1px solid #1e1e2a;
  padding: 20px 0;
}
.nav-group-title {
  font-size: 10px; font-weight: 700; color: #2a2a40;
  text-transform: uppercase; letter-spacing: 0.1em;
  padding: 0 16px 8px;
}
.nav-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 16px; font-size: 13px; color: var(--text-muted);
  border-left: 2px solid transparent;
}
.nav-item.active { color: #a8b4f0; background: var(--bg-surface); border-left-color: #3b5bdb; }
.nav-icon { font-size: 13px; opacity: 0.7; }
.nav-badge {
  margin-left: auto; font-size: 9px; font-weight: 700;
  background: rgba(193,119,0,.25); color: #c17700;
  border-radius: 8px; padding: 1px 6px;
}

/* 右侧内容 */
.settings-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* 面包屑 */
.breadcrumb {
  padding: 16px 28px 0;
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; flex-shrink: 0;
}
.crumb { color: #3a3a55; }
.crumb.link { cursor: pointer; }
.crumb.link:hover { color: #7b8cde; }
.crumb.current { color: #7070a0; }
.sep { font-size: 11px; color: #2a2a3a; }

/* 页面标题 */
.page-header { padding: 10px 28px 0; flex-shrink: 0; }
.page-title  { font-size: 20px; font-weight: 700; color: var(--text-primary); margin-bottom: 4px; }
.page-desc   { font-size: 12px; color: #3a3a55; }

/* Tab 栏 */
.tab-bar {
  display: flex; padding: 14px 28px 0;
  border-bottom: 1px solid var(--border-sub); flex-shrink: 0;
}
.tab-btn {
  padding: 8px 14px; font-size: 13px; color: #44445a;
  background: transparent; border: none; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  transition: all 0.12s; display: flex; align-items: center; gap: 6px;
}
.tab-btn:hover { color: #7070a0; }
.tab-btn.active { color: #a8b4f0; border-bottom-color: #3b5bdb; }
.tab-warn {
  font-size: 9px; font-weight: 700;
  background: rgba(193,119,0,.2); color: #c17700;
  border-radius: 8px; padding: 1px 5px;
}

/* Tab 内容 */
.loading { padding: 40px 28px; color: #3a3a55; font-size: 13px; }
.tab-panels { flex: 1; overflow-y: auto; }
.tab-panel { padding: 24px 28px; }

/* ── 基本信息 ────────────────────────────────────────────── */
.info-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
}
.span2 { grid-column: span 2; }
.info-card {
  background: var(--bg-surface); border: 1px solid var(--border-sub);
  border-radius: 10px; padding: 16px;
}
.info-label {
  font-size: 10px; font-weight: 700; color: #2e2e48;
  text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;
}
.info-value { font-size: 13px; color: var(--text-secondary); font-family: "SF Mono", Menlo, monospace; }
.info-value.highlight { color: #7b8cde; }

/* ── 权限 ────────────────────────────────────────────────── */
.perm-warning {
  display: flex; gap: 12px; align-items: flex-start;
  background: rgba(193,119,0,0.07); border: 1px solid rgba(193,119,0,0.2);
  border-radius: 10px; padding: 14px 16px; margin-bottom: 20px;
}
.pw-icon { font-size: 18px; line-height: 1.3; flex-shrink: 0; }
.pw-body { flex: 1; }
.pw-title { font-size: 13px; font-weight: 600; color: #c17700; margin-bottom: 5px; }
.pw-desc  { font-size: 12px; color: #7a6020; line-height: 1.6; }
.pw-desc code {
  background: #1e1e2a; padding: 1px 5px; border-radius: 4px;
  font-size: 11px; color: #a09040;
}
.btn-fix {
  margin-top: 10px; padding: 6px 14px; font-size: 12px; font-weight: 600;
  background: rgba(193,119,0,0.8); border: none; color: #fff;
  border-radius: 7px; cursor: pointer; transition: background 0.15s;
}
.btn-fix:hover:not(:disabled) { background: #c17700; }
.btn-fix:disabled { opacity: 0.6; cursor: not-allowed; }

.perm-section-title {
  font-size: 10px; font-weight: 700; color: #2e2e48;
  text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px;
}
.perm-list { display: flex; flex-direction: column; gap: 5px; margin-bottom: 20px; }
.perm-item {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg-surface); border: 1px solid var(--border-sub);
  border-radius: 8px; padding: 9px 14px;
  font-family: "SF Mono", Menlo, monospace; font-size: 12px;
}
.perm-item.ok      { border-color: rgba(64,192,87,.15); }
.perm-item.missing { border-color: rgba(193,119,0,.25); background: rgba(193,119,0,.04); }
.perm-type {
  font-size: 10px; padding: 2px 7px; border-radius: 5px; font-weight: 700; flex-shrink: 0;
}
.type-allow { background: rgba(64,192,87,.12);  color: #40c057; }
.type-deny  { background: rgba(224,49,49,.12);  color: #e03131; }
.perm-pattern { flex: 1; color: #9898b8; }
.perm-pattern.warn { color: #c17700; }
.perm-check        { color: #40c057; font-size: 12px; }
.perm-missing-label{ color: #c17700; font-size: 11px; }
.perm-empty { font-size: 12px; color: #2a2a40; padding: 8px 0; font-style: italic; }

/* ── 插件 ────────────────────────────────────────────────── */
.plugin-list { display: flex; flex-direction: column; gap: 10px; }
.plugin-card {
  display: flex; align-items: center; gap: 14px;
  background: var(--bg-surface); border: 1px solid var(--border-sub);
  border-radius: 10px; padding: 14px 16px;
}
.plugin-logo {
  width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0;
  background: linear-gradient(135deg, #3b5bdb, #7048e8);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700; color: white;
}
.plugin-info { flex: 1; }
.plugin-name { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 3px; }
.plugin-meta { font-size: 11px; color: #3e3e58; }
.plugin-status { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 8px; flex-shrink: 0; }
.status-on  { background: rgba(64,192,87,.1);  color: #40c057; }
.status-off { background: #1e1e2a; color: #333344; border: 1px solid #222230; }

/* ── Hooks ───────────────────────────────────────────────── */
.hook-group { margin-bottom: 22px; }
.hook-group-label {
  font-size: 10px; font-weight: 700; color: #2e2e48;
  text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px;
}
.hook-card {
  background: var(--bg-surface); border: 1px solid var(--border-sub);
  border-radius: 8px; padding: 12px 14px; margin-bottom: 6px;
}
.hook-matcher {
  font-size: 11px; color: #5a6aae;
  font-family: "SF Mono", Menlo, monospace; margin-bottom: 6px;
}
.hook-cmd {
  font-size: 11px; color: #444458;
  font-family: "SF Mono", Menlo, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── 技能 ────────────────────────────────────────────────── */
.skill-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.skill-card {
  background: var(--bg-surface); border: 1px solid var(--border-sub);
  border-radius: 10px; padding: 14px;
}
.skill-name {
  font-size: 13px; font-weight: 600; color: #c8c8e8; margin-bottom: 5px;
  font-family: "SF Mono", Menlo, monospace;
}
.skill-desc { font-size: 11px; color: #3e3e58; line-height: 1.55; }

/* 滚动条 */
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #1e1e2a; border-radius: 2px; }
</style>
