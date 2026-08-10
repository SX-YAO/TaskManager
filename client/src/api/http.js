import { markOffline } from '../composables/useServiceState.js';

const BASE = '/api';

// 这些状态码表示服务已下线（非业务错误）
const OFFLINE_STATUSES = new Set([500, 502, 503, 504]);

async function request(method, url, body) {
  try {
    const res = await fetch(BASE + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

    // 服务下线特征码 → 立即弹窗
    if (OFFLINE_STATUSES.has(res.status)) {
      markOffline();
      throw new Error(`Service offline (HTTP ${res.status})`);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.status === 204) return null;
    return res.json();
  } catch (e) {
    // 网络层失败（连接拒绝、断线）→ 立即弹窗
    if (e instanceof TypeError) {
      markOffline();
    }
    throw e;
  }
}

export const http = {
  getTasks:    ()               => request('GET',    '/tasks'),
  createTask:  (data)           => request('POST',   '/tasks', data),
  getTask:     (id)             => request('GET',    `/tasks/${id}`),
  getMessages: (id)             => request('GET',    `/tasks/${id}/messages`),
  archiveTask: (id)             => request('PATCH',  `/tasks/${id}/archive`),
  deleteTask:  (id)             => request('DELETE', `/tasks/${id}`),
  resetContext:(id)             => request('POST',   `/tasks/${id}/reset-context`),

  // 会话管理（1vN）
  getSessions:         (id)             => request('GET',    `/tasks/${id}/sessions`),
  createSession:       (id, name)       => request('POST',   `/tasks/${id}/sessions`, name ? { name } : {}),
  renameSession:       (id, sid, name)  => request('PATCH',  `/tasks/${id}/sessions/${sid}`, { name }),
  closeSession:        (id, sid)        => request('POST',   `/tasks/${id}/sessions/${sid}/close`),
  getSessionMessages:  (id, sid)        => request('GET',    `/tasks/${id}/sessions/${sid}/messages`),
  resetSessionContext: (id, sid)        => request('POST',   `/tasks/${id}/sessions/${sid}/reset-context`),
  pickDirectory:  ()            => request('GET',    '/pick-directory'),
  getBranches:    (repoPath)    => request('GET',    `/git/branches?path=${encodeURIComponent(repoPath)}`),
  shutdown:    ()               => request('POST',   '/shutdown'),
  getDiff:        (id, params)  => request('GET', `/tasks/${id}/diff${params ? '?' + new URLSearchParams(params) : ''}`),
  getDiffFile:    (id, path, hash, mode, worktreePath) => {
    const p = new URLSearchParams({ path });
    if (hash) p.set('hash', hash);
    if (mode) p.set('mode', mode);
    if (worktreePath) p.set('worktreePath', worktreePath);
    return fetch(`/api/tasks/${id}/diff/file?${p}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
  },
  getCommits:     (id, repoPath, limit = 20) => request('GET',
                    `/tasks/${id}/repos/commits?path=${encodeURIComponent(repoPath)}&limit=${limit}`),
  getWorktrees:   (id, repoPath) => request('GET',
                    `/tasks/${id}/worktrees?path=${encodeURIComponent(repoPath)}`),
  getTaskContext: (id)          => request('GET',    `/tasks/${id}/context`),
  getArtifacts:   (id)          => request('GET',    `/tasks/${id}/artifacts`),
  getArtifactContent: (id, category, filename) =>
    fetch(`${BASE}/tasks/${id}/artifacts/${category}/${encodeURIComponent(filename)}`)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); }),

  // 在 Finder 中显示产物文件或目录
  revealArtifact: (id, category, filename) =>
    request('POST', `/tasks/${id}/reveal-artifact`, { category, filename }),

  // 改动范围（Repo Scope）管理
  setScopeEnabled:       (id, enabled)              => request('PATCH',  `/tasks/${id}/scope`,        { enabled }),
  addWatchedRepo:        (id, path, baseBranch)     => request('POST',   `/tasks/${id}/repos/add`,    { path, baseBranch }),
  updateWatchedRepoBranch:(id, path, baseBranch)    => request('PATCH',  `/tasks/${id}/repos/branch`, { path, baseBranch }),
  removeWatchedRepo:     (id, path)                 => request('DELETE', `/tasks/${id}/repos`,         { path }),

  // Claude 配置管理
  getClaudeConfig:    ()          => request('GET',  '/claude/config'),
  getClaudeSettings:  ()          => request('GET',  '/claude/settings'),
  getClaudePlugins:   ()          => request('GET',  '/claude/plugins'),
  getClaudeSkills:    ()          => request('GET',  '/claude/skills'),
  addClaudePermission: (pattern)  => request('POST', '/claude/permissions/allow', { pattern }),
};
