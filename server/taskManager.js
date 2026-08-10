import { v4 as uuidv4 } from 'uuid';
import {
  initTaskFiles, readMeta, writeMeta, listAllMeta,
  deleteTaskFiles, archiveTaskFiles,
} from './storage.js';

export function createTask({ title, projectDir, purpose, agentType = 'claude',
                             dangerouslySkipPermissions = false,
                             scopeEnabled = false, watchedRepos = [] }) {
  const id = uuidv4();
  return initTaskFiles(id, { title, projectDir, purpose, agentType, dangerouslySkipPermissions,
                             scopeEnabled, watchedRepos });
}

export function listTasks() {
  return listAllMeta()
    .filter(t => !t.archivedAt)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function listRunningTasks() {
  return listAllMeta().filter(t => t.status === 'running');
}

export function getTask(taskId) {
  return readMeta(taskId);
}

export function updateTaskStatus(taskId, status) {
  const meta = readMeta(taskId);
  meta.status = status;
  writeMeta(taskId, meta);
  return meta;
}

export function setSessionId(taskId, sessionId, contextTokens = undefined, contextWindow = undefined) {
  const meta = readMeta(taskId);
  // sid 变化且旧 sid 非空 → 把旧会话归档进 history，保持可追溯
  if (sessionId !== meta.claudeSessionId && meta.claudeSessionId) {
    if (!Array.isArray(meta.sessionHistory)) meta.sessionHistory = [];
    meta.sessionHistory.push({
      sid: meta.claudeSessionId,
      endedAt: new Date().toISOString(),
      contextTokens: meta.contextTokens ?? null,
    });
  }
  meta.claudeSessionId = sessionId;
  if (contextTokens !== undefined) meta.contextTokens = contextTokens;
  if (contextWindow !== undefined) meta.contextWindow = contextWindow;
  writeMeta(taskId, meta);
}

// ── 改动范围管理 ──────────────────────────────────────────────

export function setScopeEnabled(taskId, enabled) {
  const meta = readMeta(taskId);
  meta.scopeEnabled = Boolean(enabled);
  writeMeta(taskId, meta);
  return meta;
}

// watchedRepos 条目格式：{ path: string, baseBranch: string }
// 兼容旧格式（纯字符串）：读取时自动标准化

export function normalizeRepo(entry) {
  const raw = typeof entry === 'string' ? entry : entry.path;
  const path = (raw ?? '').replace(/\/+$/, '');   // 去除尾部斜线
  const baseBranch = (typeof entry === 'string' ? 'master' : entry.baseBranch) ?? 'master';
  return { path, baseBranch };
}

export function addWatchedRepo(taskId, repoPath, baseBranch = 'master') {
  const meta = readMeta(taskId);
  if (!meta.watchedRepos) meta.watchedRepos = [];
  // 标准化现有条目
  meta.watchedRepos = meta.watchedRepos.map(normalizeRepo);
  const exists = meta.watchedRepos.some(r => r.path === repoPath);
  if (!exists) {
    meta.watchedRepos.push({ path: repoPath, baseBranch });
    writeMeta(taskId, meta);
  }
  return meta;
}

export function updateWatchedRepoBranch(taskId, repoPath, baseBranch) {
  const meta = readMeta(taskId);
  if (!meta.watchedRepos) return meta;
  meta.watchedRepos = meta.watchedRepos.map(normalizeRepo).map(r =>
    r.path === repoPath ? { ...r, baseBranch } : r
  );
  writeMeta(taskId, meta);
  return meta;
}

export function removeWatchedRepo(taskId, repoPath) {
  const meta = readMeta(taskId);
  if (!meta.watchedRepos) return meta;
  meta.watchedRepos = meta.watchedRepos
    .map(normalizeRepo)
    .filter(r => r.path !== repoPath);
  writeMeta(taskId, meta);
  return meta;
}

// 归档：项目内容 move 到 ~/.task-manager/archive/，registry 标记 archived
export function archiveTask(taskId) {
  return archiveTaskFiles(taskId);
}

// 彻底删除：删项目内容 + 从 registry 移除
export function deleteTask(taskId) {
  deleteTaskFiles(taskId);
}
