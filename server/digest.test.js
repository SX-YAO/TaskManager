import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-digest-'));
process.env.TASK_MANAGER_HOME = TMP;

const { createTask } = await import('./taskManager.js');
const { writeProgress, appendPitfall } = await import('./storage.js');
const { addTaskEntry, addGlobalEntry } = await import('./conventions.js');
const { buildDigest } = await import('./digest.js');

const PROJECT = path.join(TMP, 'proj');
let taskId;

before(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  taskId = createTask({ title: 't', projectDir: PROJECT, purpose: 'p' }).id;
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('空任务 digest 只有标题 + 指针两行', () => {
  const d = buildDigest(taskId);
  const lines = d.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '[任务纪律简报]');
  assert.ok(lines[1].includes('task-discipline skill'));
});

test('全量数据：进度/待办/踩坑/规范各行齐全', () => {
  writeProgress(taskId, { summary: '鉴权拆分完成', completedSteps: [], pendingSteps: ['写测试', '联调'], updatedAt: null });
  appendPitfall(taskId, { timestamp: 't', type: 'error', description: 'token 未刷新导致 403', solution: 'x' });
  addTaskEntry(taskId, { text: '本任务规范甲', origin: 'human' });
  addGlobalEntry({ text: '全局规范乙', origin: 'human' });

  const d = buildDigest(taskId);
  assert.ok(d.includes('进度：鉴权拆分完成'));
  assert.ok(d.includes('待办：2 项未完成'));
  assert.ok(d.includes('近期踩坑：'));
  assert.ok(d.includes('token 未刷新导致 403'));
  assert.ok(d.includes('规范：任务级 1 条 / 全局 1 条'));
});

test('工具告警行出现在简报顶部', () => {
  const d = buildDigest(taskId, ['task:pitfall 缺少 description']);
  const lines = d.split('\n');
  assert.ok(lines[1].startsWith('⚠ 上轮工具调用失败：task:pitfall 缺少 description'));
});

test('summary 超长截断 80 字', () => {
  writeProgress(taskId, { summary: '长'.repeat(100), completedSteps: [], pendingSteps: [], updatedAt: null });
  const d = buildDigest(taskId);
  const line = d.split('\n').find(l => l.startsWith('进度：'));
  assert.ok(line.length <= 83);   // 进度： 3 字 + 80
});

test('踩坑缺 description 的旧数据整条跳过，不渲染 undefined', () => {
  const dir = path.join(PROJECT, '.task-manager', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pitfalls.json'),
    JSON.stringify({ items: [{ timestamp: 't', type: 'error', solution: 'x' }] }));
  const d = buildDigest(taskId);
  assert.ok(!d.includes('undefined'));
  assert.ok(!d.includes('近期踩坑'));
});
