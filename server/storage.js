import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

// TASK_MANAGER_HOME 环境变量可覆盖数据根目录（测试隔离用）
const BASE          = process.env.TASK_MANAGER_HOME || path.join(os.homedir(), '.task-manager');
const REGISTRY_FILE = path.join(BASE, 'registry.json');
const ARCHIVE_DIR   = path.join(BASE, 'archive');
const GLOBAL_CONVENTIONS_FILE = path.join(BASE, 'conventions.json');

// ─── UUID 校验 ────────────────────────────────────────────────
function assertValidTaskId(taskId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
    throw new Error(`非法 taskId: ${taskId}`);
  }
}

// ─── Registry 读写（原子操作，用临时文件 rename 保证一致性）──────
function readRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); }
  catch { return []; }
}

function writeRegistry(entries) {
  fs.mkdirSync(BASE, { recursive: true });
  const tmp = `${REGISTRY_FILE}.tmp.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, REGISTRY_FILE); // 同文件系统 rename 是原子的
}

// ─── 项目内的任务目录路径 ──────────────────────────────────────
// 返回 projectDir/.task-manager/{taskId}/
function taskContentDir(projectDir, taskId) {
  assertValidTaskId(taskId);
  return path.join(projectDir, '.task-manager', taskId);
}

// 通过 registry 查到 projectDir，再定位内容目录
function resolveContentDir(taskId) {
  const meta = readMeta(taskId);
  return taskContentDir(meta.projectDir, taskId);
}

// 清理项目内空的 .task-manager 父目录
function cleanupParentDir(projectDir) {
  const tmDir = path.join(projectDir, '.task-manager');
  try {
    if (fs.existsSync(tmDir) && fs.readdirSync(tmDir).length === 0) {
      fs.rmdirSync(tmDir);
    }
  } catch { /* 忽略 */ }
}

// ─── Registry 条目操作 ────────────────────────────────────────
export function readMeta(taskId) {
  assertValidTaskId(taskId);
  const entry = readRegistry().find(t => t.id === taskId);
  if (!entry) throw new Error(`任务不存在: ${taskId}`);
  return entry;
}

export function writeMeta(taskId, meta) {
  assertValidTaskId(taskId);
  const registry = readRegistry();
  const idx = registry.findIndex(t => t.id === taskId);
  if (idx === -1) throw new Error(`任务不存在: ${taskId}`);
  registry[idx] = meta;
  writeRegistry(registry);
}

export function listAllMeta() {
  return readRegistry();
}

// ─── 初始化任务文件 ───────────────────────────────────────────
export function initTaskFiles(taskId, { title, projectDir, purpose, agentType = 'claude',
                                        dangerouslySkipPermissions = false,
                                        scopeEnabled = false, watchedRepos = [] }) {
  assertValidTaskId(taskId);
  const dir = taskContentDir(projectDir, taskId);

  // 在项目目录内创建结构
  fs.mkdirSync(path.join(dir, 'artifacts', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions', 'main'), { recursive: true }); // 保证主会话目录存在

  fs.writeFileSync(path.join(dir, 'purpose.md'), `## 任务目的\n\n${purpose}\n`);
  fs.writeFileSync(
    path.join(dir, 'progress.json'),
    JSON.stringify({ summary: '', completedSteps: [], pendingSteps: [], updatedAt: null }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'pitfalls.json'), JSON.stringify({ items: [] }, null, 2));
  fs.writeFileSync(path.join(dir, 'conventions.json'), JSON.stringify({ items: [] }, null, 2));

  // 注册到 registry —— 只存创建时已知的信息，此后不再同步内容字段
  const entry = {
    id: taskId,
    title,
    projectDir,
    purpose,                                         // 创建时填写，全局可读
    agentType,
    dangerouslySkipPermissions: Boolean(dangerouslySkipPermissions),
    createdAt: new Date().toISOString(),
    // 运行态字段（可变，但不同步内容文件）
    status: 'idle',
    sessions: [{
      id: 'main', name: '主会话', isMain: true,
      status: 'idle',
      claudeSessionId: null, contextTokens: null, contextWindow: null,
      sessionHistory: [],
      createdAt: new Date().toISOString(), closedAt: null,
    }],
    claudeSessionId: null,
    archivedAt: null,
    // 改动范围：统一列表，AI 声明与用户手动添加共用同一数组
    scopeEnabled: Boolean(scopeEnabled),
    watchedRepos: Array.isArray(watchedRepos) ? watchedRepos.map(r =>
      typeof r === 'string' ? { path: r.replace(/\/+$/, ''), baseBranch: 'master' } : r
    ) : [],
  };
  const registry = readRegistry();
  registry.push(entry);
  writeRegistry(registry);

  return entry;
}

// ─── 消息读写 ─────────────────────────────────────────────────
export function appendMessage(taskId, message) {
  const file = path.join(resolveContentDir(taskId), 'messages.jsonl');
  fs.appendFileSync(file, JSON.stringify(message) + '\n');
}

export function readMessages(taskId) {
  const file = path.join(resolveContentDir(taskId), 'messages.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ─── 会话消息（1vN）───────────────────────────────────────────
function assertValidSessionId(sessionId) {
  if (sessionId !== 'main' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error(`非法 sessionId: ${sessionId}`);
  }
}

// {projectDir}/.task-manager/{taskId}/sessions/{sessionId}
export function sessionDir(taskId, sessionId) {
  assertValidSessionId(sessionId);
  return path.join(resolveContentDir(taskId), 'sessions', sessionId);
}

export function appendSessionMessage(taskId, sessionId, message) {
  const dir = sessionDir(taskId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify(message) + '\n');
}

export function readSessionMessages(taskId, sessionId) {
  const file = path.join(sessionDir(taskId, sessionId), 'messages.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// 旧格式迁移：根目录 messages.jsonl → sessions/main/messages.jsonl
// 幂等：根文件不存在返回 false
export function migrateLegacyMessages(taskId) {
  const dir = resolveContentDir(taskId);
  const legacy = path.join(dir, 'messages.jsonl');
  if (!fs.existsSync(legacy)) return false;
  const mainDir = path.join(dir, 'sessions', 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.renameSync(legacy, path.join(mainDir, 'messages.jsonl'));
  return true;
}

// ─── 工具系统写入（由 server/tools/ 下的工具调用）──────────────

// 覆盖写入 progress.json（task:progress 工具调用）
export function writeProgress(taskId, data) {
  const file = path.join(resolveContentDir(taskId), 'progress.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// 追加到 pitfalls.json（task:pitfall 工具调用）
// 容错：文件损坏则重建 {items:[]}；原子写（tmp+rename）防并发截断
export function appendPitfall(taskId, item) {
  const file = path.join(resolveContentDir(taskId), 'pitfalls.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { data = { items: [] }; }   // 损坏则丢弃旧内容重建
  if (!Array.isArray(data.items)) data.items = [];
  data.items.push(item);
  const tmp = `${file}.tmp.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ─── 任务上下文（供前端展示面板）─────────────────────────────
// 各文件独立容错：单个文件损坏不影响整个 context 返回，避免 404 掩盖真实错误
function safeParseJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { console.warn(`[storage] JSON 解析失败 ${file}: ${e.message}`); return fallback; }
}
export function readTaskContext(taskId) {
  const dir = resolveContentDir(taskId);
  const purpose = fs.existsSync(path.join(dir, 'purpose.md'))
    ? fs.readFileSync(path.join(dir, 'purpose.md'), 'utf-8') : '';
  const progress = safeParseJSON(path.join(dir, 'progress.json'),
    { summary: '', completedSteps: [], pendingSteps: [], updatedAt: null });
  const pitfalls = safeParseJSON(path.join(dir, 'pitfalls.json'), { items: [] });
  return { purpose, progress, pitfalls };
}

// ─── 产出物 ───────────────────────────────────────────────────
export function listArtifacts(taskId) {
  const base = path.join(resolveContentDir(taskId), 'artifacts');
  const read = (sub) => {
    const dir = path.join(base, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.html'));
  };
  return { reports: read('reports'), plans: read('plans') };
}

export function readArtifact(taskId, category, filename) {
  const file = path.join(resolveContentDir(taskId), 'artifacts', category, filename);
  if (!fs.existsSync(file)) throw new Error('文件不存在');
  return fs.readFileSync(file, 'utf-8');
}

// ─── 删除（彻底）────────────────────────────────────────────
export function deleteTaskFiles(taskId) {
  const meta = readMeta(taskId);
  const dir = taskContentDir(meta.projectDir, taskId);

  // ① 删除项目目录内的任务文件
  fs.rmSync(dir, { recursive: true, force: true });
  cleanupParentDir(meta.projectDir);

  // ② 从 registry 移除（无全局痕迹）
  writeRegistry(readRegistry().filter(t => t.id !== taskId));
}

// ─── 归档（move 到 ~/.task-manager/archive/）─────────────────
export function archiveTaskFiles(taskId) {
  const meta = readMeta(taskId);
  const srcDir  = taskContentDir(meta.projectDir, taskId);
  const destDir = path.join(ARCHIVE_DIR, taskId);

  // ① 移动项目内容到全局归档目录
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  if (fs.existsSync(srcDir)) {
    fs.renameSync(srcDir, destDir);
  }
  cleanupParentDir(meta.projectDir);

  // ② 更新 registry（保留条目，但标记归档）
  meta.status = 'archived';
  meta.archivedAt = new Date().toISOString();
  writeMeta(taskId, meta);

  return meta;
}

// ─── 规范（conventions）读写：任务级 + 全局 ─────────────────────
function readConventionsFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(data.items)) data.items = [];
    return data;
  } catch { return { items: [] }; }        // 缺失/损坏一律容错为空
}

function writeConventionsFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readTaskConventions(taskId) {
  return readConventionsFile(path.join(resolveContentDir(taskId), 'conventions.json'));
}
export function writeTaskConventions(taskId, data) {
  writeConventionsFile(path.join(resolveContentDir(taskId), 'conventions.json'), data);
}
export function readGlobalConventions() {
  return readConventionsFile(GLOBAL_CONVENTIONS_FILE);
}
export function writeGlobalConventions(data) {
  writeConventionsFile(GLOBAL_CONVENTIONS_FILE, data);
}
