import { Router } from 'express';
import { execFile, spawn as _spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createTask, listTasks, getTask, archiveTask, deleteTask,
         setScopeEnabled, addWatchedRepo, removeWatchedRepo,
         updateWatchedRepoBranch, normalizeRepo,
         listSessions, getSession, createSession, renameSession,
         closeSession, setSessionSid } from './taskManager.js';
import { getCache, setCache } from './diff-cache.js';
import { readSessionMessages, appendSessionMessage, readTaskContext, listArtifacts, readArtifact } from './storage.js';
import { stopRuntime, broadcastTask } from './runtime.js';
import { aggregateStatus } from './taskManager.js';
import { readConfig } from './config.js';
import { runRetro } from './retro.js';
import { listTaskConventions, listGlobalConventions, addTaskEntry, addGlobalEntry,
         updateTaskEntry, updateGlobalEntry, removeTaskEntry, removeGlobalEntry,
         promoteTaskEntry, demoteGlobalToTask, confirmGlobalEntry } from './conventions.js';
import { listSkills, getSkillTree, readSkillFile, writeUserSkillFile, deleteUserSkillFile } from './skillManager.js';
import { record, summary as metricsSummary } from './metrics.js';

const execFileAsync = promisify(execFile);

const router = Router();

// ─── Claude 配置相关常量 ───────────────────────────────────────
const CLAUDE_SETTINGS_FILE    = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_PLUGINS_DIR      = path.join(os.homedir(), '.claude', 'plugins', 'cache');
const CLAUDE_INSTALLED_FILE   = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const REQUIRED_PERM           = 'Write(.task-manager/**)';

function readClaudeSettings() {
  if (!fs.existsSync(CLAUDE_SETTINGS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8')); }
  catch { return {}; }
}

function writeClaudeSettings(data) {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_FILE), { recursive: true });
  const tmp = `${CLAUDE_SETTINGS_FILE}.tmp.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CLAUDE_SETTINGS_FILE);
}

router.get('/tasks', (_req, res) => {
  res.json(listTasks());
});

router.post('/tasks', (req, res) => {
  const { title, projectDir, purpose, agentType, dangerouslySkipPermissions,
          scopeEnabled, watchedRepos } = req.body;
  if (!title || !projectDir || !purpose) {
    return res.status(400).json({ error: 'title, projectDir, purpose 为必填项' });
  }
  const meta = createTask({ title, projectDir, purpose, agentType, dangerouslySkipPermissions,
                            scopeEnabled, watchedRepos });
  res.status(201).json(meta);
});

router.get('/tasks/:id', (req, res) => {
  try {
    res.json(getTask(req.params.id));
  } catch {
    res.status(404).json({ error: '任务不存在' });
  }
});

router.get('/tasks/:id/messages', (req, res) => {
  try {
    getTask(req.params.id);
    res.json(readSessionMessages(req.params.id, 'main'));
  } catch {
    res.status(404).json({ error: '任务不存在' });
  }
});

router.get('/tasks/:id/context', (req, res) => {
  try { res.json(readTaskContext(req.params.id)); }
  catch { res.status(404).json({ error: '任务不存在' }); }
});

router.get('/tasks/:id/artifacts', (req, res) => {
  try { res.json(listArtifacts(req.params.id)); }
  catch { res.status(404).json({ error: '任务不存在' }); }
});

router.get('/tasks/:id/artifacts/:category/:filename', (req, res) => {
  try {
    const content = readArtifact(req.params.id, req.params.category, req.params.filename);
    res.type('text/plain').send(content);
  } catch { res.status(404).json({ error: '文件不存在' }); }
});

// 在 Finder 中显示产物文件（macOS open -R）
router.post('/tasks/:id/reveal-artifact', (req, res) => {
  let meta;
  try { meta = getTask(req.params.id); } catch { return res.status(404).json({ error: '任务不存在' }); }

  const { category, filename } = req.body ?? {};
  const artifactsBase = path.join(
    meta.projectDir, '.task-manager', req.params.id, 'artifacts',
  );

  // 有具体文件：用 open -R 选中该文件；仅传目录：直接打开目录
  const target = (category && filename)
    ? path.join(artifactsBase, category, filename)
    : artifactsBase;

  execFile('open', ['-R', target], (err) => {
    if (!err) return res.json({ ok: true });
    // -R 对目录无效时退回直接打开
    execFile('open', [target], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ ok: true });
    });
  });
});

router.patch('/tasks/:id/archive', (req, res) => {
  try {
    const meta = archiveTask(req.params.id);
    runRetro(req.params.id);   // 后台复盘：提炼经验进全局候选 + retrospective.md，不阻塞响应
    res.json(meta);
  } catch {
    res.status(404).json({ error: '任务不存在' });
  }
});

router.delete('/tasks/:id', (req, res) => {
  try {
    getTask(req.params.id); // 验证存在
    deleteTask(req.params.id);
    res.status(204).end();
  } catch {
    res.status(404).json({ error: '任务不存在' });
  }
});

// 手动重开会话：清当前 sid（归档进 sessionHistory），下次发消息开新会话并读取任务文件恢复上下文
// legacy 入口，代理 main 会话
router.post('/tasks/:id/reset-context', (req, res) => {
  try {
    const s = getSession(req.params.id, 'main');
    setSessionSid(req.params.id, 'main', null, null, s.contextWindow);
    res.json({ ok: true, message: '已重开会话，下次发消息将开新会话并读取任务文件恢复上下文' });
  } catch {
    res.status(404).json({ error: '任务不存在' });
  }
});

// ── 会话管理（1vN）────────────────────────────────────────────

router.get('/tasks/:id/sessions', (req, res) => {
  try { res.json(listSessions(req.params.id)); }
  catch { res.status(404).json({ error: '任务不存在' }); }
});

router.post('/tasks/:id/sessions', (req, res) => {
  try {
    const session = createSession(req.params.id, req.body?.name);
    res.status(201).json(session);
  } catch { res.status(404).json({ error: '任务不存在' }); }
});

router.patch('/tasks/:id/sessions/:sid', (req, res) => {
  const { name } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'name 必填' });
  try { res.json(renameSession(req.params.id, req.params.sid, name)); }
  catch (e) {
    if (/不存在/.test(e.message)) return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// 关闭会话：运行中的先走完整 stop 流程（杀 agent + 保存部分内容）；主会话拒绝
router.post('/tasks/:id/sessions/:sid/close', (req, res) => {
  try {
    // 先做主会话拒绝，再产生任何副作用（杀 agent/落盘），避免被拒绝的请求留下痕迹
    if (getSession(req.params.id, req.params.sid).isMain) {
      return res.status(400).json({ error: '主会话不可关闭' });
    }
    const rt = stopRuntime(req.params.id, req.params.sid);
    if (rt) {
      // 与 WS stop 流程一致：部分内容以 interrupted 落盘，避免丢消息
      if (rt.partialText) {
        appendSessionMessage(req.params.id, req.params.sid, {
          role: 'assistant', content: rt.partialText,
          timestamp: new Date().toISOString(), toolCalls: [], interrupted: true,
        });
      }
      rt.processing = false; rt.partialText = ''; rt.roundToolCalls = [];
    }
    const session = closeSession(req.params.id, req.params.sid);
    broadcastTask(req.params.id, { type: 'session_status_change', sessionId: req.params.sid, status: 'closed' });
    broadcastTask(req.params.id, { type: 'status_change', status: aggregateStatus(getTask(req.params.id)) });
    res.json(session);
  } catch (e) {
    if (/主会话不可关闭/.test(e.message)) return res.status(400).json({ error: e.message });
    res.status(404).json({ error: e.message });
  }
});

router.get('/tasks/:id/sessions/:sid/messages', (req, res) => {
  try {
    getSession(req.params.id, req.params.sid); // 验证存在
    res.json(readSessionMessages(req.params.id, req.params.sid));
  } catch { res.status(404).json({ error: '会话不存在' }); }
});

// 会话级手动重开（唯一重开方式；撑爆只提示不自动清 sid）
router.post('/tasks/:id/sessions/:sid/reset-context', (req, res) => {
  try {
    const s = getSession(req.params.id, req.params.sid);
    setSessionSid(req.params.id, req.params.sid, null, null, s.contextWindow);
    res.json({ ok: true, message: '已重开会话，下次发消息将开新会话并读取任务文件恢复上下文' });
  } catch { res.status(404).json({ error: '会话不存在' }); }
});

// ── 改动范围（Repo Scope）管理 ─────────────────────────────────

// 切换固定范围开关（scopeEnabled）
router.patch('/tasks/:id/scope', (req, res) => {
  try {
    const { enabled } = req.body;
    const meta = setScopeEnabled(req.params.id, enabled);
    res.json(meta);
  } catch { res.status(404).json({ error: '任务不存在' }); }
});

// 添加 repo 到 watchedRepos（含可选 baseBranch，默认 main）
router.post('/tasks/:id/repos/add', async (req, res) => {
  const { path: repoPath, baseBranch = 'main' } = req.body;
  if (!repoPath) return res.status(400).json({ error: 'path 必填' });
  try {
    const meta = addWatchedRepo(req.params.id, repoPath, baseBranch);
    res.json({ watchedRepos: meta.watchedRepos.map(normalizeRepo) });
  } catch { res.status(404).json({ error: '任务不存在' }); }
});

// 更新 repo 的 baseBranch
router.patch('/tasks/:id/repos/branch', (req, res) => {
  const { path: repoPath, baseBranch } = req.body;
  if (!repoPath || !baseBranch) return res.status(400).json({ error: 'path 和 baseBranch 必填' });
  try {
    const meta = updateWatchedRepoBranch(req.params.id, repoPath, baseBranch);
    res.json({ watchedRepos: meta.watchedRepos.map(normalizeRepo) });
  } catch { res.status(404).json({ error: '任务不存在' }); }
});

// 从 watchedRepos 中移除 repo
router.delete('/tasks/:id/repos', (req, res) => {
  const { path: repoPath } = req.body;
  if (!repoPath) return res.status(400).json({ error: 'path 必填' });
  try {
    const meta = removeWatchedRepo(req.params.id, repoPath);
    res.json({ watchedRepos: meta.watchedRepos.map(normalizeRepo) });
  } catch { res.status(404).json({ error: '任务不存在' }); }
});

// ── 规范（conventions）管理 ───────────────────────────────────

router.get('/conventions', (_req, res) => {
  res.json(listGlobalConventions());
});

router.post('/conventions', (req, res) => {
  const { text } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: 'text 必填' });
  const { entry } = addGlobalEntry({ text: text.trim(), origin: 'human', candidate: false });
  record('convention_edit', { op: 'add', scope: 'global' });
  res.status(201).json(entry);
});

router.patch('/conventions/:cid', (req, res) => {
  const { text } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: 'text 必填' });
  const r = updateGlobalEntry(req.params.cid, text.trim());
  if (r.error) return res.status(404).json({ error: r.error });
  record('convention_edit', { op: 'update', scope: 'global' });
  res.json(r.entry);
});

router.delete('/conventions/:cid', (req, res) => {
  removeGlobalEntry(req.params.cid);
  record('convention_edit', { op: 'delete', scope: 'global' });
  res.status(204).end();
});

router.post('/conventions/:cid/confirm', (req, res) => {
  const r = confirmGlobalEntry(req.params.cid);
  if (r.error) return res.status(404).json({ error: r.error });
  record('convention_edit', { op: 'confirm', scope: 'global' });
  res.json(r.entry);
});

router.post('/conventions/:cid/demote', (req, res) => {
  const { taskId } = req.body ?? {};
  if (!taskId) return res.status(400).json({ error: 'taskId 必填' });
  const r = demoteGlobalToTask(req.params.cid, taskId);
  if (r.error) return res.status(404).json({ error: r.error });
  record('convention_edit', { op: 'demote', scope: 'global', taskId });
  res.json(r.entry);
});

router.get('/tasks/:id/conventions', (req, res) => {
  try { res.json(listTaskConventions(req.params.id)); }
  catch { res.status(404).json({ error: '任务不存在' }); }
});

router.post('/tasks/:id/conventions', (req, res) => {
  const { text } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: 'text 必填' });
  try {
    const { entry } = addTaskEntry(req.params.id, { text: text.trim(), origin: 'human', candidate: false });
    record('convention_edit', { op: 'add', scope: 'task', taskId: req.params.id });
    res.status(201).json(entry);
  } catch { res.status(404).json({ error: '任务不存在' }); }
});

router.patch('/tasks/:id/conventions/:cid', (req, res) => {
  const { text } = req.body ?? {};
  if (!text?.trim()) return res.status(400).json({ error: 'text 必填' });
  const r = updateTaskEntry(req.params.id, req.params.cid, text.trim());
  if (r.error) return res.status(404).json({ error: r.error });
  record('convention_edit', { op: 'update', scope: 'task', taskId: req.params.id });
  res.json(r.entry);
});

router.delete('/tasks/:id/conventions/:cid', (req, res) => {
  removeTaskEntry(req.params.id, req.params.cid);
  record('convention_edit', { op: 'delete', scope: 'task', taskId: req.params.id });
  res.status(204).end();
});

router.post('/tasks/:id/conventions/:cid/promote', (req, res) => {
  const r = promoteTaskEntry(req.params.id, req.params.cid);
  if (r.error) return res.status(404).json({ error: r.error });
  record('convention_edit', { op: 'promote', scope: 'task', taskId: req.params.id });
  res.json(r.entry);
});

// ── 技能（skills）管理 ───────────────────────────────────────

router.get('/skills', (_req, res) => {
  res.json(listSkills());
});

router.get('/skills/:name/tree', (req, res) => {
  try { res.json(getSkillTree(req.params.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/skills/:name/file', (req, res) => {
  try { res.json(readSkillFile(req.params.name, req.query.path)); }
  catch (e) {
    if (/不存在/.test(e.message)) return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

router.put('/skills/:name/file', (req, res) => {
  const { content } = req.body ?? {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content 必填' });
  try {
    writeUserSkillFile(req.params.name, req.query.path, content);
    res.json(readSkillFile(req.params.name, req.query.path));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/skills/:name/file', (req, res) => {
  try {
    deleteUserSkillFile(req.params.name, req.query.path);
    res.status(204).end();
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 埋点聚合 ─────────────────────────────────────────────────

router.get('/metrics/summary', (_req, res) => {
  res.json(metricsSummary());
});

// 服务健康状态（心跳检测用）
router.get('/status', (_req, res) => {
  res.json({ ok: true, pid: process.pid, uptime: Math.floor(process.uptime()) });
});

// ── Diff 辅助函数 ──────────────────────────────────────────────

/** 找到有效的 diff range（工作区 vs base branch） */
async function findDiffRange(cwd, baseBranch) {
  const ranges = [
    `origin/${baseBranch}`,   // 工作区 vs 远端 base（最完整）
    baseBranch,               // fallback：本地 base
  ];
  for (const r of ranges) {
    try {
      await execFileAsync('git', ['diff', r, '--numstat'], { cwd });
      return r;
    } catch { /* 尝试下一个 */ }
  }
  return null;  // 无 base → 调用方处理
}

/** 未追踪文件 diff（git diff --no-index exit code=1 为正常，需 spawn 而非 execFile）*/
function diffNoIndex(filePath) {
  return new Promise(resolve => {
    const proc = _spawn('git', ['diff', '--no-index', '--unified=3', '/dev/null', filePath]);
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.on('close', () => resolve(out));
  });
}

// ── GET /tasks/:id/diff — 文件列表（快速，不含 diff 内容）──────

router.get('/tasks/:id/diff', async (req, res) => {
  let meta;
  try { meta = getTask(req.params.id); } catch { return res.status(404).json({ error: '任务不存在' }); }

  // mode: 'uncommitted'（默认，只有未提交）| 'branch'（当前分支 vs 目标分支）| 'commit'（单次 commit）
  const { hash, repoPath: _repoPath, mode = 'branch' } = req.query;
  const repoPath = _repoPath ? _repoPath.replace(/\/+$/, '') : undefined;  // 去尾斜线，与 normalizeRepo 对齐

  const rawRepos = meta.watchedRepos?.length ? meta.watchedRepos : [meta.projectDir];
  const repos = rawRepos.map(normalizeRepo).filter(r => !repoPath || r.path === repoPath);

  async function getDiffForRepo({ path: cwd, baseBranch }) {
    const repoName = cwd.replace(/\/+$/, '').split('/').pop();
    const prefix   = repos.length > 1 ? `${repoName}/` : '';

    // ── worktree 路径选择 ──────────────────────────────────
    // 优先使用前端传入的 worktreePath（用户主动选择）
    // 其次自动检测 .claude/worktrees/ 下含 taskId 的目录
    let actualCwd = cwd;
    const wtParam = req.query.worktreePath;
    if (wtParam && fs.existsSync(wtParam)) {
      actualCwd = wtParam.replace(/\/+$/, '');
    } else {
      const worktreeBase = path.join(cwd, '.claude', 'worktrees');
      if (fs.existsSync(worktreeBase)) {
        const wtDirs = fs.readdirSync(worktreeBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        // 只匹配含当前 taskId 的 worktree，找不到则用主仓库（不取第一个）
        const matched = wtDirs.find(name => name.includes(meta.id));
        if (matched) actualCwd = path.join(worktreeBase, matched);
      }
    }

    const { stdout: branchStdout } = await execFileAsync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: actualCwd }
    ).catch(() => ({ stdout: '' }));
    const branch = branchStdout.trim();

    function parseNumstat(numstat) {
      return numstat.trim().split('\n').filter(Boolean).map(line => {
        const [added, deleted, filePath] = line.split('\t');
        return {
          path: prefix + filePath, absPath: path.join(actualCwd, filePath),
          added: +added || 0, deleted: +deleted || 0,
          untracked: false, repo: repoName,
        };
      });
    }

    // ── commit 模式 ──
    if (hash || mode === 'commit') {
      const h = hash || 'HEAD';
      const { stdout: numstat } = await execFileAsync(
        'git', ['show', h, '--numstat', '--format='], { cwd: actualCwd }
      ).catch(() => ({ stdout: '' }));
      return { branch, files: parseNumstat(numstat), mode: 'commit', repo: repoName, cwd: actualCwd, baseBranch };
    }

    // ── 当前分支 vs 目标分支（已提交，不含工作区）──
    if (mode === 'branch') {
      const ranges = [`origin/${baseBranch}..HEAD`, `${baseBranch}..HEAD`];
      let files = [];
      for (const r of ranges) {
        try {
          const { stdout: numstat } = await execFileAsync('git', ['diff', r, '--numstat'], { cwd: actualCwd });
          files = parseNumstat(numstat);
          break;
        } catch { /* 尝试下一个 */ }
      }
      return { branch, files, mode: 'branch', repo: repoName, cwd: actualCwd, baseBranch };
    }

    // ── 未提交内容（staged + unstaged，不含已提交）──
    const { stdout: numstat } = await execFileAsync(
      'git', ['diff', 'HEAD', '--numstat'], { cwd: actualCwd }
    ).catch(() => ({ stdout: '' }));
    const files = parseNumstat(numstat);

    // 未追踪文件
    const { stdout: untrackedRaw } = await execFileAsync(
      'git', ['ls-files', '--others', '--exclude-standard'], { cwd: actualCwd }
    ).catch(() => ({ stdout: '' }));
    for (const rel of untrackedRaw.trim().split('\n').filter(Boolean)) {
      const absPath = path.join(actualCwd, rel);
      let lines = 0;
      try { lines = fs.readFileSync(absPath, 'utf-8').split('\n').length; } catch {}
      files.push({ path: prefix + rel, absPath, added: lines, deleted: 0, untracked: true, repo: repoName });
    }

    return { branch, files, mode: 'uncommitted', repo: repoName, cwd: actualCwd, baseBranch };
  }

  try {
    const results   = await Promise.allSettled(repos.map(getDiffForRepo));
    const succeeded = results.filter(r => r.status === 'fulfilled').map(r => r.value);

    if (!succeeded.length) {
      return res.status(400).json({ error: '所有 repo 均无法获取 diff' });
    }

    const allFiles  = succeeded.flatMap(r => r.files);
    const branch    = succeeded[0].branch;
    const repoStats = succeeded.map(r => ({
      name: r.repo, branch: r.branch,
      baseBranch: repos.find(rp => rp.path === r.cwd || rp.path.startsWith(r.cwd))?.baseBranch ?? 'master',
      added:   r.files.reduce((s, f) => s + f.added,   0),
      deleted: r.files.reduce((s, f) => s + f.deleted, 0),
    }));

    // 响应：文件列表 + 统计，不含 rawDiff
    res.json({ branch, files: allFiles, repos: repoStats });

    // 后台预生成（不阻塞响应）
    setImmediate(() => preCacheDiffs(meta.id, succeeded));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /tasks/:id/diff/file — 单文件 diff（工作区或指定 commit）──

router.get('/tasks/:id/diff/file', async (req, res) => {
  const { path: filePath, hash, mode = 'uncommitted', worktreePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path 必填' });

  let meta;
  try { meta = getTask(req.params.id); } catch { return res.status(404).json({ error: '任务不存在' }); }

  // 缓存 key 含 mode + worktreePath，防止跨模式/跨 worktree 缓存污染
  const cacheKey = hash ? `${filePath}:commit:${hash}` : `${filePath}:${mode}:${worktreePath || ''}`;
  const cached = hash ? null : getCache(meta.id, cacheKey);
  if (cached !== null) return res.type('text/plain').send(cached);

  const repos = (meta.watchedRepos?.length ? meta.watchedRepos : [meta.projectDir]).map(normalizeRepo);
  const repo  = repos.find(r => filePath.startsWith(r.path)) ?? { path: meta.projectDir, baseBranch: 'master' };
  // worktreePath 优先，否则用主仓库路径
  const cwd = (worktreePath && fs.existsSync(worktreePath)) ? worktreePath.replace(/\/+$/, '') : repo.path;
  const rel = path.relative(cwd, filePath);

  let diffContent = '';
  try {
    if (hash || mode === 'commit') {
      const h = hash || 'HEAD';
      const { stdout } = await execFileAsync(
        'git', ['show', h, '--unified=3', '--', rel], { cwd }
      ).catch(() => ({ stdout: '' }));
      diffContent = stdout;
    } else if (mode === 'branch') {
      const ranges = [`origin/${repo.baseBranch}..HEAD`, `${repo.baseBranch}..HEAD`];
      for (const r of ranges) {
        try {
          const { stdout } = await execFileAsync(
            'git', ['diff', r, '--unified=3', '--', rel], { cwd }
          );
          diffContent = stdout; break;
        } catch {}
      }
      setCache(meta.id, cacheKey, diffContent);   // key 含 mode，不污染其他模式
    } else {
      // 未提交内容：git diff HEAD -- <rel>（或未追踪文件）
      const isUntracked = !fs.existsSync(filePath)
        ? false
        : await execFileAsync('git', ['ls-files', '--error-unmatch', rel], { cwd })
            .then(() => false)
            .catch(() => true);

      if (isUntracked) {
        diffContent = await diffNoIndex(filePath);
      } else {
        const { stdout } = await execFileAsync(
          'git', ['diff', 'HEAD', '--unified=3', '--', rel], { cwd }
        ).catch(() => ({ stdout: '' }));
        diffContent = stdout;
      }
      setCache(meta.id, cacheKey, diffContent);   // key 含 mode
    }
  } catch (e) {
    console.warn('[diff/file]', e.message);
  }

  res.type('text/plain').send(diffContent);
});

// ── GET /tasks/:id/worktrees — 列出某 repo 的所有 worktree ────
router.get('/tasks/:id/worktrees', async (req, res) => {
  const { path: repoPath } = req.query;
  if (!repoPath) return res.status(400).json({ error: 'path 必填' });
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    // 解析 porcelain 格式：worktree <path>\nHEAD <sha>\nbranch <ref>\n\n
    const worktrees = [];
    let cur = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) worktrees.push(cur);
        cur = { path: line.slice(9).trim(), head: '', branch: '' };
      } else if (line.startsWith('HEAD ') && cur) {
        cur.head = line.slice(5).trim();
      } else if (line.startsWith('branch ') && cur) {
        cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      } else if (line === '' && cur) {
        worktrees.push(cur); cur = null;
      }
    }
    if (cur) worktrees.push(cur);
    res.json(worktrees);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /tasks/:id/repos/commits — commit 列表 ────────────────

router.get('/tasks/:id/repos/commits', async (req, res) => {
  const { path: repoPath, limit = '20' } = req.query;
  if (!repoPath) return res.status(400).json({ error: 'path 必填' });

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `--max-count=${parseInt(limit, 10)}`, '--format=%H|%s|%ar'],
      { cwd: repoPath }
    );
    const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, relTime] = line.split('|');
      return { hash, message: message ?? '', relTime: relTime ?? '' };
    });
    res.json(commits);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /tasks/:id/diff — commit 模式支持（新增 hash 参数）──────
// 在主 diff 路由中同时支持工作区和 commit 查看

// ── 后台预生成：逐批生成所有文件 diff 并写缓存 ─────────────────

async function preCacheDiffs(taskId, repoResults) {
  const BATCH = 5;
  const DELAY = 50; // ms between batches

  // 追踪文件优先（diff 生成通常更快）
  const allFiles = repoResults.flatMap(r =>
    r.files
      .filter(f => !f.untracked)
      .concat(r.files.filter(f => f.untracked))
      .map(f => ({ ...f, cwd: r.cwd, baseBranch: r.baseBranch, range: r.range }))
  );

  for (let i = 0; i < allFiles.length; i += BATCH) {
    const batch = allFiles.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async f => {
      // 已有缓存跳过
      if (getCache(taskId, f.absPath) !== null) return;
      try {
        let content = '';
        if (f.untracked) {
          content = await diffNoIndex(f.absPath);
        } else if (f.range) {
          const rel = path.relative(f.cwd, f.absPath);
          const { stdout } = await execFileAsync(
            'git', ['diff', f.range, '--unified=3', '--', rel], { cwd: f.cwd }
          ).catch(() => ({ stdout: '' }));
          content = stdout;
        }
        setCache(taskId, f.absPath, content);
      } catch { /* 单文件失败不影响其他 */ }
    }));
    await new Promise(r => setTimeout(r, DELAY));
  }
}

router.post('/shutdown', (_req, res) => {
  res.json({ message: '服务正在关闭…' });
  setTimeout(() => process.exit(0), 300);
});


// 获取指定目录的 git 分支列表（本地 + 远端）
router.get('/git/branches', async (req, res) => {
  const { path: repoPath } = req.query;
  if (!repoPath) return res.status(400).json({ error: 'path 必填' });

  try {
    const { stdout } = await execFileAsync(
      'git', ['branch', '-a', '--format=%(refname:short)'], { cwd: repoPath }
    );
    const all = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);

    // 区分本地和远端，去掉 HEAD 指针
    const local  = all.filter(b => !b.startsWith('origin/') && !b.startsWith('remotes/'));
    const remote = all
      .filter(b => b.startsWith('origin/') || b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\//, ''))
      .filter(b => !b.endsWith('/HEAD'));

    res.json({ local, remote });
  } catch (e) {
    // 非 git 目录或其他错误，返回空列表不报错
    res.json({ local: [], remote: [] });
  }
});

router.get('/pick-directory', (_req, res) => {
  // macOS 原生文件夹选择对话框
  execFile(
    'osascript',
    ['-e', 'POSIX path of (choose folder with prompt "选择项目目录")'],
    (err, stdout) => {
      if (err) return res.status(400).json({ error: '未选择目录' });
      res.json({ path: stdout.trim() });
    },
  );
});

// ═══════════════════════════════════════════════════════════════
// Claude 配置管理接口
// ═══════════════════════════════════════════════════════════════

// 基本信息：命令、版本、配置文件路径
router.get('/claude/config', async (_req, res) => {
  const cfg = readConfig();
  const cmd = [cfg.agentCommand, ...(cfg.agentCommandArgs ?? [])].join(' ');
  let version = '未知';
  try {
    const { stdout } = await execFileAsync(
      cfg.agentCommand, [...(cfg.agentCommandArgs ?? []), '--version'],
      { timeout: 5000 },
    );
    version = stdout.trim();
  } catch { /* 命令不存在或超时，保持未知 */ }

  res.json({ command: cmd, version, configPath: CLAUDE_SETTINGS_FILE });
});

// 权限 + Hooks（来自 settings.json）
router.get('/claude/settings', (_req, res) => {
  const s = readClaudeSettings();
  res.json({
    permissions: {
      allow: s.permissions?.allow ?? [],
      deny:  s.permissions?.deny  ?? [],
    },
    hooks: s.hooks ?? {},
  });
});

// ── 已安装插件定位 ─────────────────────────────────────────────
// 实际目录结构：cache/<marketplace>/<plugin>/<version>/，元数据在 .claude-plugin/plugin.json。
// 权威清单为 installed_plugins.json（记录每个插件的 installPath/version），
// 扫描 cache 仅作兜底（如清单缺失或损坏）。

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

/** 从 installed_plugins.json 解析出安装记录 [{installPath, version, scope}] */
function listInstalledFromManifest() {
  const data = readJsonSafe(CLAUDE_INSTALLED_FILE);
  if (!data?.plugins || typeof data.plugins !== 'object') return [];
  const installs = [];
  for (const entries of Object.values(data.plugins)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (e?.installPath && fs.existsSync(e.installPath)) installs.push(e);
    }
  }
  return installs;
}

/** 兜底：扫描 cache/<marketplace>/<plugin>/<version>/，每个插件取最新版本目录 */
function scanPluginDirsFromCache() {
  if (!fs.existsSync(CLAUDE_PLUGINS_DIR)) return [];
  const installs = [];
  for (const marketplace of fs.readdirSync(CLAUDE_PLUGINS_DIR, { withFileTypes: true })) {
    if (!marketplace.isDirectory()) continue;
    const mDir = path.join(CLAUDE_PLUGINS_DIR, marketplace.name);
    for (const plugin of fs.readdirSync(mDir, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      const pDir = path.join(mDir, plugin.name);
      const versions = fs.readdirSync(pDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); // 版本号降序
      if (versions.length) {
        installs.push({ installPath: path.join(pDir, versions[0]), version: versions[0] });
      }
    }
  }
  return installs;
}

/** 解析单个插件目录 → { name, version, description, source, skillCount, dir } */
function describePluginDir(dir, manifestVersion) {
  const meta = readJsonSafe(path.join(dir, '.claude-plugin', 'plugin.json')) ?? {};
  const skillsDir = path.join(dir, 'skills');
  // 技能为目录结构：skills/<skillName>/SKILL.md；兼容旧式平铺 skills/*.md
  let skillCount = 0;
  if (fs.existsSync(skillsDir)) {
    skillCount = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
      .length
      + fs.readdirSync(skillsDir).filter(f => f.endsWith('.md') && f !== 'SKILL.md').length;
  }
  return {
    name: meta.name ?? path.basename(path.dirname(dir)),
    version: meta.version ?? manifestVersion ?? '',
    description: meta.description ?? '',
    source: meta.repository?.url ?? meta.homepage ?? '',
    skillCount,
    dir,
  };
}

/** 所有已安装插件（清单优先，cache 扫描兜底） */
function listInstalledPlugins() {
  let installs = listInstalledFromManifest();
  if (!installs.length) installs = scanPluginDirsFromCache();
  return installs.map(e => describePluginDir(e.installPath, e.version));
}

// 插件列表（含技能计数）
router.get('/claude/plugins', (_req, res) => {
  res.json(listInstalledPlugins().map(({ dir, ...p }) => ({ ...p, enabled: true })));
});

// 技能列表（遍历插件 skills/<name>/SKILL.md，解析 frontmatter 描述）
router.get('/claude/skills', (_req, res) => {
  const skills = [];

  for (const plugin of listInstalledPlugins()) {
    const skillsDir = path.join(plugin.dir, 'skills');
    if (!fs.existsSync(skillsDir)) continue;

    // 新式：skills/<skillName>/SKILL.md
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(skillsDir, d.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      skills.push({ name: d.name, description: readSkillDescription(file), plugin: plugin.name });
    }
    // 兼容旧式平铺：skills/*.md
    for (const f of fs.readdirSync(skillsDir).filter(f => f.endsWith('.md') && f !== 'SKILL.md')) {
      skills.push({
        name: f.replace(/\.md$/, ''),
        description: readSkillDescription(path.join(skillsDir, f)),
        plugin: plugin.name,
      });
    }
  }

  res.json(skills);
});

/** 从 SKILL.md 提取描述：优先 YAML frontmatter 的 description，fallback 正文首个非标题行 */
function readSkillDescription(file) {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descLine = fmMatch[1].split('\n').find(l => l.startsWith('description:'));
      if (descLine) {
        const v = descLine.replace('description:', '').trim();
        // frontmatter 值可能带 YAML 引号，剥掉
        return v.replace(/^["']|["']$/g, '');
      }
    }
    const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
    return body.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() ?? '';
  } catch { return ''; }
}

// 一键添加权限到 permissions.allow
router.post('/claude/permissions/allow', (req, res) => {
  const { pattern } = req.body;
  if (!pattern) return res.status(400).json({ error: 'pattern 必填' });

  const settings = readClaudeSettings();
  if (!settings.permissions)       settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  if (!settings.permissions.allow.includes(pattern)) {
    settings.permissions.allow.push(pattern);
    writeClaudeSettings(settings);
  }

  res.json({ allow: settings.permissions.allow });
});

export default router;
