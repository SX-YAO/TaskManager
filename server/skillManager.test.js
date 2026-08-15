import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-skill-'));
process.env.TASK_MANAGER_HOME = TMP;
process.env.CLAUDE_SKILLS_DIR = path.join(TMP, 'claude-skills');   // 隔离 native 同步目标，不碰真实 ~/.claude/skills

const sm = await import('./skillManager.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('listSkills 枚举默认技能，source=default', () => {
  const list = sm.listSkills();
  const td = list.find(s => s.name === 'task-discipline');
  assert.ok(td, '应发现 task-discipline');
  assert.equal(td.source, 'default');
  assert.equal(td.fileCount, 3);
  assert.ok(td.description.includes('长任务纪律'));
});

test('用户版单文件覆盖 → mixed；readSkillFile 读到用户内容', () => {
  sm.writeUserSkillFile('task-discipline', 'progress-guide.md', '# 用户改过的进度指南\n');
  const list = sm.listSkills();
  assert.equal(list.find(s => s.name === 'task-discipline').source, 'mixed');
  const f = sm.readSkillFile('task-discipline', 'progress-guide.md');
  assert.equal(f.source, 'user');
  assert.ok(f.content.includes('用户改过'));
  const untouched = sm.readSkillFile('task-discipline', 'pitfall-guide.md');
  assert.equal(untouched.source, 'default');
});

test('用户新增文件 → tree 标 new；删除用户文件 → 恢复默认', () => {
  sm.writeUserSkillFile('task-discipline', 'team-notes.md', '# 团队备忘\n');
  const tree = sm.getSkillTree('task-discipline');
  assert.equal(tree.find(f => f.path === 'team-notes.md').source, 'new');
  assert.equal(tree.find(f => f.path === 'progress-guide.md').source, 'user');
  sm.deleteUserSkillFile('task-discipline', 'progress-guide.md');   // 有默认版 → 恢复默认
  assert.equal(sm.readSkillFile('task-discipline', 'progress-guide.md').source, 'default');
  sm.deleteUserSkillFile('task-discipline', 'team-notes.md');       // 用户新增 → 真删
  assert.equal(sm.getSkillTree('task-discipline').find(f => f.path === 'team-notes.md'), undefined);
});

test('SKILL.md 缺 frontmatter 的 name/description → 拒绝写入', () => {
  assert.throws(() => sm.writeUserSkillFile('task-discipline', 'SKILL.md', '# 无头\n'), /frontmatter/);
});

test('路径穿越被拒绝', () => {
  assert.throws(() => sm.readSkillFile('task-discipline', '../x.md'), /非法/);
  assert.throws(() => sm.listSkills && sm.getSkillTree('..'), /非法/);
});

test('getPromptInjection 输出技能清单文本', () => {
  const s = sm.getPromptInjection();
  assert.ok(s.includes('task-discipline'));
});

test('无标记的既有同名目录不被覆盖（防误删用户自有技能）', () => {
  const target = path.join(process.env.CLAUDE_SKILLS_DIR, 'task-discipline');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'user-own.md'), '# 用户自己的技能\n');

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try { sm.syncNativeSkill('task-discipline'); }
  finally { console.warn = origWarn; }

  assert.ok(fs.existsSync(path.join(target, 'user-own.md')), '用户文件不应被删除');
  assert.ok(!fs.existsSync(path.join(target, 'SKILL.md')), '不应写入受管内容');
  assert.ok(warns.some(w => w.includes('跳过同步')), '应有 warn 提示');

  // 恢复受管状态，避免影响其他用例
  fs.rmSync(target, { recursive: true, force: true });
  sm.syncNativeSkill('task-discipline');
  assert.ok(fs.existsSync(path.join(target, '.task-manager-managed')));
});
