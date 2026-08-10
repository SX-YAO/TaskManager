import { v4 as uuidv4 } from 'uuid';
import {
  initTaskFiles, readMeta, writeMeta, listAllMeta,
  deleteTaskFiles, archiveTaskFiles, migrateLegacyMessages,
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
    .map(withDerivedStatus)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// legacy：旧版按任务维度判断运行中，仅迁移/兼容用
export function listRunningTasks() {
  return listAllMeta().filter(t => t.status === 'running');
}

export function getTask(taskId) {
  return withDerivedStatus(readMeta(taskId));
}

// legacy：旧版任务级状态写入，仅迁移/兼容用
export function updateTaskStatus(taskId, status) {
  const meta = readMeta(taskId);
  meta.status = status;
  writeMeta(taskId, meta);
  return meta;
}

// legacy：旧版任务级 sid 写入，仅迁移/兼容用（新代码请用 setSessionSid）
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

// ── 会话模型（1vN）───────────────────────────────────────────

export function listSessions(taskId) {
  return readMeta(taskId).sessions ?? [];
}

export function getSession(taskId, sessionId) {
  const s = listSessions(taskId).find(x => x.id === sessionId);
  if (!s) throw new Error(`会话不存在: ${sessionId}`);
  return s;
}

function writeSession(taskId, sessionId, updater) {
  const meta = readMeta(taskId);
  const idx = (meta.sessions ?? []).findIndex(x => x.id === sessionId);
  if (idx === -1) throw new Error(`会话不存在: ${sessionId}`);
  meta.sessions[idx] = updater(meta.sessions[idx]);
  writeMeta(taskId, meta);
  return meta.sessions[idx];
}

export function createSession(taskId, name) {
  const meta = readMeta(taskId);
  if (!Array.isArray(meta.sessions)) meta.sessions = [];
  const session = {
    id: uuidv4(),
    name: name?.trim() || `会话 ${meta.sessions.length + 1}`,
    isMain: false,
    status: 'idle',
    claudeSessionId: null, contextTokens: null, contextWindow: null,
    sessionHistory: [],
    createdAt: new Date().toISOString(), closedAt: null,
  };
  meta.sessions.push(session);
  writeMeta(taskId, meta);
  return session;
}

export function renameSession(taskId, sessionId, name) {
  if (!name?.trim()) throw new Error('名称不能为空');
  return writeSession(taskId, sessionId, s => ({ ...s, name: name.trim() }));
}

export function closeSession(taskId, sessionId) {
  const s = getSession(taskId, sessionId);
  if (s.isMain) throw new Error('主会话不可关闭');
  return writeSession(taskId, sessionId, x =>
    ({ ...x, status: 'closed', closedAt: new Date().toISOString() }));
}

export function updateSessionStatus(taskId, sessionId, status) {
  return writeSession(taskId, sessionId, x => ({ ...x, status }));
}

// 会话级 sid 管理（旧 setSessionId 的下沉版本）
export function setSessionSid(taskId, sessionId, sid, contextTokens, contextWindow) {
  writeSession(taskId, sessionId, s => {
    const next = { ...s };
    if (sid !== s.claudeSessionId && s.claudeSessionId) {
      next.sessionHistory = [...(s.sessionHistory ?? []), {
        sid: s.claudeSessionId,
        endedAt: new Date().toISOString(),
        contextTokens: s.contextTokens ?? null,
      }];
    }
    next.claudeSessionId = sid;
    if (contextTokens !== undefined) next.contextTokens = contextTokens;
    if (contextWindow !== undefined) next.contextWindow = contextWindow;
    return next;
  });
}

// 聚合状态：任一非 closed 会话 running → running；否则主会话状态
export function aggregateStatus(meta) {
  const sessions = meta.sessions ?? [];
  if (sessions.some(s => s.status === 'running')) return 'running';
  return sessions.find(s => s.isMain)?.status ?? meta.status ?? 'idle';
}

function withDerivedStatus(meta) {
  return { ...meta, status: aggregateStatus(meta) };
}

// 运行中会话清单（启动恢复 / 目录冲突检测用）
export function listRunningSessions() {
  return listAllMeta().flatMap(m =>
    (m.sessions ?? [])
      .filter(s => s.status === 'running')
      .map(s => ({ taskId: m.id, sessionId: s.id, projectDir: m.projectDir, title: m.title })),
  );
}

// 旧格式迁移：meta 无 sessions → 合成 main 会话 + 迁移消息文件。幂等。
export function migrateLegacyTask(taskId) {
  const meta = readMeta(taskId);
  if (Array.isArray(meta.sessions)) return false;
  meta.sessions = [{
    id: 'main', name: '主会话', isMain: true,
    status: meta.status === 'archived' ? 'idle' : (meta.status ?? 'idle'),
    claudeSessionId: meta.claudeSessionId ?? null,
    contextTokens: meta.contextTokens ?? null,
    contextWindow: meta.contextWindow ?? null,
    sessionHistory: meta.sessionHistory ?? [],
    createdAt: meta.createdAt, closedAt: null,
  }];
  delete meta.claudeSessionId;
  delete meta.contextTokens;
  delete meta.contextWindow;
  delete meta.sessionHistory;
  writeMeta(taskId, meta);
  try { migrateLegacyMessages(taskId); } catch (e) {
    console.warn(`[migrate] 任务 ${taskId} 消息迁移失败（忽略，不阻塞）: ${e.message}`);
  }
  return true;
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
