import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const BASE          = path.join(os.homedir(), '.task-manager');
const REGISTRY_FILE = path.join(BASE, 'registry.json');
const OLD_TASKS_DIR = path.join(BASE, 'tasks');       // 旧架构目录
const ARCHIVE_DIR   = path.join(BASE, 'archive');
const CONFIG_FILE   = path.join(BASE, 'config.json');

const DEFAULT_CONFIG = {
  maxConcurrency: 3,
  agentCommand: 'claude',
  agentCommandArgs: [],
};

// ── 原子写 registry ──────────────────────────────────────────
function writeRegistry(data) {
  const tmp = `${REGISTRY_FILE}.tmp.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, REGISTRY_FILE);
}

function readRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); }
  catch { return []; }
}

// ── 创建目录结构 ───────────────────────────────────────────
fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
console.log(`✓ 数据目录: ${BASE}`);

// ── registry.json 初始化（不存在则创建空数组）───────────────
if (!fs.existsSync(REGISTRY_FILE)) {
  writeRegistry([]);
  console.log(`✓ 创建 registry: ${REGISTRY_FILE}`);
} else {
  console.log(`- registry 已存在: ${REGISTRY_FILE}`);
}

// ── 配置文件（合并写入，保留已有字段）───────────────────────
let config = { ...DEFAULT_CONFIG };
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
    console.log(`- 已合并配置: ${CONFIG_FILE}`);
  } catch { console.warn('⚠ 配置文件解析失败，使用默认值'); }
} else {
  console.log(`✓ 创建配置: ${CONFIG_FILE}`);
}
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

// ── Claude 权限配置：确保 Write(.task-manager/**) 在全局 allow 列表里 ─
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const REQUIRED_PERM   = 'Write(.task-manager/**)';

try {
  let claudeSettings = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    claudeSettings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8'));
  }
  const allow = claudeSettings?.permissions?.allow ?? [];
  if (!allow.includes(REQUIRED_PERM)) {
    if (!claudeSettings.permissions) claudeSettings.permissions = {};
    if (!claudeSettings.permissions.allow) claudeSettings.permissions.allow = [];
    claudeSettings.permissions.allow.push(REQUIRED_PERM);
    const tmp = `${CLAUDE_SETTINGS}.tmp.${randomBytes(6).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(claudeSettings, null, 2));
    fs.renameSync(tmp, CLAUDE_SETTINGS);
    console.log(`✓ 已写入 Claude 权限：${REQUIRED_PERM}`);
  } else {
    console.log(`- Claude 权限已存在：${REQUIRED_PERM}`);
  }
} catch (e) {
  console.warn(`⚠ 无法更新 Claude 权限配置：${e.message}`);
  console.warn(`  请手动在 ${CLAUDE_SETTINGS} 的 permissions.allow 中添加：`);
  console.warn(`  "${REQUIRED_PERM}"`);
}

// ── 旧数据迁移（~/.task-manager/tasks/ → projectDir/.task-manager/{id}/）──
if (fs.existsSync(OLD_TASKS_DIR)) {
  const ids = fs.readdirSync(OLD_TASKS_DIR)
    .filter(name => fs.existsSync(path.join(OLD_TASKS_DIR, name, 'meta.json')));

  if (ids.length > 0) {
    console.log(`\n⚙ 检测到旧版任务数据（${ids.length} 个），开始迁移…`);
    const registry = readRegistry();
    const existingIds = new Set(registry.map(t => t.id));
    let migrated = 0;

    for (const id of ids) {
      if (existingIds.has(id)) {
        console.log(`  - 跳过（已在 registry）: ${id}`);
        continue;
      }
      try {
        const oldDir = path.join(OLD_TASKS_DIR, id);
        const meta   = JSON.parse(fs.readFileSync(path.join(oldDir, 'meta.json'), 'utf-8'));
        const { title, projectDir, status, agentType, dangerouslySkipPermissions, claudeSessionId, createdAt, archivedAt } = meta;

        if (!projectDir) {
          console.log(`  ⚠ 跳过（无 projectDir）: ${id}`);
          continue;
        }

        // 目标目录：projectDir/.task-manager/{id}/
        const destDir = path.join(projectDir, '.task-manager', id);
        fs.mkdirSync(path.join(destDir, 'artifacts', 'reports'), { recursive: true });
        fs.mkdirSync(path.join(destDir, 'artifacts', 'plans'),   { recursive: true });

        // 复制内容文件（不包含 meta.json）
        const files = ['purpose.md', 'progress.json', 'pitfalls.json', 'messages.jsonl'];
        for (const f of files) {
          const src = path.join(oldDir, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, f));
        }
        // 复制 artifacts
        const oldArtifacts = path.join(oldDir, 'artifacts');
        if (fs.existsSync(oldArtifacts)) {
          fs.cpSync(oldArtifacts, path.join(destDir, 'artifacts'), { recursive: true });
        }

        // 添加到 registry
        registry.push({
          id, title, projectDir,
          status: status === 'running' ? 'idle' : (status ?? 'idle'),
          agentType: agentType ?? 'claude',
          dangerouslySkipPermissions: Boolean(dangerouslySkipPermissions),
          claudeSessionId: claudeSessionId ?? null,
          createdAt: createdAt ?? new Date().toISOString(),
          archivedAt: archivedAt ?? null,
        });

        console.log(`  ✓ 迁移: ${title} → ${destDir}`);
        migrated++;
      } catch (e) {
        console.warn(`  ⚠ 迁移失败 ${id}: ${e.message}`);
      }
    }

    if (migrated > 0) {
      writeRegistry(registry);
      console.log(`  → 已迁移 ${migrated} 个任务`);
      console.log(`  → 旧目录可删除：rm -rf "${OLD_TASKS_DIR}"`);
    } else {
      console.log(`  → 所有任务已在 registry，旧目录可删除：rm -rf "${OLD_TASKS_DIR}"`);
    }
  }
}

// ── 检查 Agent 命令 ──────────────────────────────────────────
const cmd = [config.agentCommand, ...(config.agentCommandArgs ?? [])].join(' ');
try {
  const ver = execSync(`${cmd} --version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  console.log(`\n✓ Agent 命令: ${cmd}  (${ver})`);
} catch {
  console.warn(`\n⚠ 未检测到命令 "${cmd}"，请确认已安装并配置正确`);
  console.warn(`  修改 ${CONFIG_FILE} 中的 agentCommand / agentCommandArgs 字段`);
}

console.log('\n初始化完成，运行 npm run dev 启动应用。');
