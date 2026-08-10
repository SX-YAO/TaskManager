import { Router } from 'express';
import { execFile, spawn as _spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createTask, listTasks, getTask, archiveTask, deleteTask,
         setScopeEnabled, addWatchedRepo, removeWatchedRepo,
         updateWatchedRepoBranch, normalizeRepo, setSessionId } from './taskManager.js';
import { getCache, setCache } from './diff-cache.js';
import { readMessages, readTaskContext, listArtifacts, readArtifact } from './storage.js';
import { readConfig } from './config.js';

const execFileAsync = promisify(execFile);

const router = Router();

// ─── Claude 配置相关常量 ───────────────────────────────────────
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_PLUGINS_DIR   = path.join(os.homedir(), '.claude', 'plugins', 'cache');
const REQUIRED_PERM        = 'Write(.task-manager/**)';

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
    getTask(req.params.id); // 验证任务存在
    res.json(readMessages(req.params.id));
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
    res.json(archiveTask(req.params.id));
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
router.post('/tasks/:id/reset-context', (req, res) => {
  try {
    const meta = getTask(req.params.id);
    setSessionId(req.params.id, null, null, meta.contextWindow);
    res.json({ ok: true, message: '已重开会话，下次发消息将开新会话并读取任务文件恢复上下文' });
  } catch {
    res.status(404).json({ error: '任务不存在' });
  }
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

// 插件列表（扫描 ~/.claude/plugins/cache/）
router.get('/claude/plugins', (_req, res) => {
  if (!fs.existsSync(CLAUDE_PLUGINS_DIR)) return res.json([]);

  const plugins = fs.readdirSync(CLAUDE_PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const dir = path.join(CLAUDE_PLUGINS_DIR, d.name);
      let name = d.name, version = '', source = '';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
        name    = pkg.name    ?? d.name;
        version = pkg.version ?? '';
        source  = pkg.repository?.url ?? pkg.homepage ?? '';
      } catch { /* package.json 不存在，使用目录名 */ }

      const skillsDir  = path.join(dir, 'skills');
      const skillCount = fs.existsSync(skillsDir)
        ? fs.readdirSync(skillsDir).filter(f => f.endsWith('.md')).length
        : 0;

      return { name, version, source, skillCount, enabled: true };
    });

  res.json(plugins);
});

// 技能列表（合并所有插件的 skills/*.md，平铺展示）
router.get('/claude/skills', (_req, res) => {
  if (!fs.existsSync(CLAUDE_PLUGINS_DIR)) return res.json([]);

  const skills = [];
  const pluginDirs = fs.readdirSync(CLAUDE_PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(CLAUDE_PLUGINS_DIR, d.name));

  for (const dir of pluginDirs) {
    const skillsDir = path.join(dir, 'skills');
    if (!fs.existsSync(skillsDir)) continue;

    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const name = file.replace(/\.md$/, '');
      let description = '';
      try {
        const content = fs.readFileSync(path.join(skillsDir, file), 'utf-8');
        // 尝试从 YAML frontmatter 取 description
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const descLine = fmMatch[1].split('\n').find(l => l.startsWith('description:'));
          if (descLine) description = descLine.replace('description:', '').trim();
        }
        // fallback：取正文第一段非空行
        if (!description) {
          const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
          description = body.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '';
        }
      } catch { /* 读取失败跳过 */ }
      skills.push({ name, description });
    }
  }

  res.json(skills);
});

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
