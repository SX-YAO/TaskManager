/**
 * skillManager.js — 技能管理（TaskManager 拥有技能，agent 适配器负责投递）
 *
 * 技能 = 多文件目录（仅平铺，不支持子目录）：
 *   默认版  server/skills/<name>/            （随仓库）
 *   用户版  ~/.task-manager/skills/<name>/   （文件粒度覆盖默认版 / 新增）
 * 生效版 = 用户版文件优先，默认版补齐。
 *
 * 投递：
 *   native（claude）：syncNativeSkill 整目录同步到 ~/.claude/skills/<name>/
 *   prompt（兜底）：getPromptInjection() 输出清单文本，agent 自行 Read
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { record } from './metrics.js';

const DEFAULT_DIR = fileURLToPath(new URL('./skills/', import.meta.url));
const USER_DIR    = path.join(process.env.TASK_MANAGER_HOME || path.join(os.homedir(), '.task-manager'), 'skills');
// CLAUDE_SKILLS_DIR 供测试隔离；生产默认 ~/.claude/skills
const NATIVE_DIR  = process.env.CLAUDE_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');

const NAME_RE = /^[\w][\w-]*$/;
function assertName(name) {
  if (!NAME_RE.test(name ?? '')) throw new Error(`非法技能名: ${name}`);
}
function assertRel(rel) {
  if (!rel || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) {
    throw new Error(`非法文件路径: ${rel}`);
  }
}

function listDirFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name);
}

/** 生效版文件表：Map<rel, { source: 'default'|'user'|'new', abs }>（用户覆盖默认） */
function effectiveFiles(name) {
  assertName(name);
  const map = new Map();
  for (const f of listDirFiles(path.join(DEFAULT_DIR, name))) {
    map.set(f, { source: 'default', abs: path.join(DEFAULT_DIR, name, f) });
  }
  for (const f of listDirFiles(path.join(USER_DIR, name))) {
    const prev = map.get(f);
    map.set(f, { source: prev ? 'user' : 'new', abs: path.join(USER_DIR, name, f) });
  }
  return map;
}

function skillNames() {
  const names = new Set();
  for (const base of [DEFAULT_DIR, USER_DIR]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory()) names.add(d.name);
    }
  }
  return [...names];
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const get = (k) => m[1].split('\n').find(l => l.startsWith(`${k}:`))
    ?.replace(`${k}:`, '').trim().replace(/^["']|["']$/g, '') ?? '';
  return { name: get('name'), description: get('description'), version: get('version') };
}

export function listSkills() {
  return skillNames().map(name => {
    const eff = effectiveFiles(name);
    const sk = eff.get('SKILL.md');
    const fm = sk ? parseFrontmatter(fs.readFileSync(sk.abs, 'utf-8')) : {};
    const sources = new Set([...eff.values()].map(f => f.source));
    const source = sources.has('user') || sources.has('new')
      ? (sources.has('default') ? 'mixed' : 'user')
      : 'default';
    return { name, description: fm.description ?? '', version: fm.version ?? '', source, fileCount: eff.size };
  }).filter(s => s.fileCount > 0);
}

export function getSkillTree(name) {
  return [...effectiveFiles(name).entries()].map(([rel, f]) => ({
    path: rel, source: f.source, size: fs.statSync(f.abs).size,
  }));
}

export function readSkillFile(name, rel) {
  assertRel(rel);
  const f = effectiveFiles(name).get(rel);
  if (!f) throw new Error(`文件不存在: ${name}/${rel}`);
  return { content: fs.readFileSync(f.abs, 'utf-8'), source: f.source };
}

export function writeUserSkillFile(name, rel, content) {
  assertName(name); assertRel(rel);
  if (rel === 'SKILL.md') {
    const fm = parseFrontmatter(content);
    if (!fm.name || !fm.description) {
      throw new Error('SKILL.md 必须包含 frontmatter 的 name 与 description');
    }
  }
  const dir = path.join(USER_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
  syncNativeSkill(name);
}

export function deleteUserSkillFile(name, rel) {
  assertName(name); assertRel(rel);
  const file = path.join(USER_DIR, name, rel);
  if (fs.existsSync(file)) fs.rmSync(file);
  syncNativeSkill(name);   // 有默认版 → 恢复默认；用户新增 → 从生效版消失
}

/** native 投递：整目录同步生效版到 ~/.claude/skills/<name>/（本目录由我们独占管理） */
export function syncNativeSkill(name) {
  try {
    const eff = effectiveFiles(name);
    const target = path.join(NATIVE_DIR, name);
    fs.rmSync(target, { recursive: true, force: true });
    if (!eff.size) return;
    fs.mkdirSync(target, { recursive: true });
    for (const [rel, f] of eff) fs.copyFileSync(f.abs, path.join(target, rel));
    const sources = new Set([...eff.values()].map(f => f.source));
    record('skill_load', { name, source: sources.has('user') || sources.has('new') ? 'user' : 'default' });
  } catch (e) { console.warn(`[skill] native 同步失败 ${name}:`, e.message); }
}

export function syncAllNativeSkills() {
  for (const s of listSkills()) syncNativeSkill(s.name);
}

/** prompt 模式投递：技能清单文本（description 常驻，全文按需 Read） */
export function getPromptInjection() {
  return listSkills()
    .map(s => `- 技能 ${s.name}：${s.description}（全文在 ${path.join(USER_DIR, s.name)}/ 或默认目录，涉及时阅读）`)
    .join('\n');
}
