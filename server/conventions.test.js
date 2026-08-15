import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-conv-'));
process.env.TASK_MANAGER_HOME = TMP;

const { createTask } = await import('./taskManager.js');
const conv = await import('./conventions.js');

const PROJECT = path.join(TMP, 'proj');
let taskA, taskB;

before(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  taskA = createTask({ title: 'a', projectDir: PROJECT, purpose: 'p' }).id;
  taskB = createTask({ title: 'b', projectDir: PROJECT, purpose: 'p' }).id;
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('addTaskEntry 新增 + 规范化去重合并 hits', () => {
  const r1 = conv.addTaskEntry(taskA, { text: '提交前必须跑 npm test', candidate: true, origin: 'distill', sources: [taskA] });
  assert.equal(r1.merged, false);
  assert.equal(r1.entry.candidate, true);
  const r2 = conv.addTaskEntry(taskA, { text: '提交前必须跑npm test', candidate: false, origin: 'distill', sources: [taskA] });
  assert.equal(r2.merged, true);           // 标点空白差异视为同一条
  assert.equal(r2.entry.hits, 2);
  assert.equal(conv.listTaskConventions(taskA).length, 1);
});

test('mergeTaskEntry 按 1-based 序号合并，序号越界返回 error', () => {
  const bad = conv.mergeTaskEntry(taskA, 99, 'x');
  assert.ok(bad.error);
  const ok = conv.mergeTaskEntry(taskA, 1, '提交前必须跑 npm test（含 client）');
  assert.equal(ok.entry.text, '提交前必须跑 npm test（含 client）');
  assert.equal(ok.entry.hits, 3);
});

test('promoteToGlobal 单任务来源 → candidate=true；≥2 任务 → candidate=false', () => {
  const r1 = conv.promoteToGlobal('统一用 pnpm', [taskA], 'distill');
  assert.equal(r1.entry.candidate, true);
  const r2 = conv.promoteToGlobal('统一用 pnpm', [taskB], 'distill');
  assert.equal(r2.merged, true);
  assert.equal(r2.entry.candidate, false);                    // sources≥2 自动转正
  assert.deepEqual([...r2.entry.sources].sort(), [taskA, taskB].sort());
});

test('confirmGlobalEntry / demoteGlobalToTask / promoteTaskEntry', () => {
  const g = conv.addGlobalEntry({ text: '全局人工规范', origin: 'human' });
  assert.equal(g.entry.candidate, false);
  conv.demoteGlobalToTask(g.entry.id, taskB);
  assert.equal(conv.listGlobalConventions().find(e => e.id === g.entry.id), undefined);
  const inB = conv.listTaskConventions(taskB).find(e => e.text === '全局人工规范');
  assert.ok(inB && inB.candidate === false);
  conv.promoteTaskEntry(taskB, inB.id);                        // 人工提升 → 全局 candidate=false
  assert.equal(conv.listTaskConventions(taskB).find(e => e.id === inB.id), undefined);
  const back = conv.listGlobalConventions().find(e => e.text === '全局人工规范');
  assert.ok(back && back.candidate === false);
});

test('convention 工具 handle：add/merge/promote + 参数校验返回 error', async () => {
  const tool = (await import('./tools/convention.js')).default;
  const ctx = { taskId: taskA, origin: 'distill' };
  assert.ok(tool.handle({ action: 'add' }, ctx).error);                       // 缺 text
  assert.ok(tool.handle({ action: 'merge', text: 'x' }, ctx).error);          // 缺 target
  assert.ok(tool.handle({ action: 'noop', text: 'x' }, ctx).error);           // 未知 action
  assert.equal(tool.handle({ action: 'add', text: '新规范甲', candidate: 'true' }, ctx), undefined);
  const list = conv.listTaskConventions(taskA);
  assert.ok(list.some(e => e.text === '新规范甲' && e.origin === 'distill'));
  assert.equal(tool.handle({ action: 'promote', text: '候选升全局', sources: `${taskA},${taskB}` }, ctx), undefined);
  const g = conv.listGlobalConventions().find(e => e.text === '候选升全局');
  assert.ok(g && g.candidate === false);                       // 两个来源 → 直接转正
});

test('readTaskConventions 文件缺失容错返回空 items', async () => {
  const storage = await import('./storage.js');
  // 新任务初始化后删除 conventions.json，覆盖 readConventionsFile 的 catch 分支
  const taskC = createTask({ title: 'c', projectDir: PROJECT, purpose: 'p' }).id;
  fs.rmSync(path.join(PROJECT, '.task-manager', taskC, 'conventions.json'));
  assert.deepEqual(storage.readTaskConventions(taskC), { items: [] });
});

test('readTaskConventions 文件损坏容错返回空 items 而非抛异常', async () => {
  const storage = await import('./storage.js');
  const file = path.join(PROJECT, '.task-manager', taskB, 'conventions.json');
  fs.writeFileSync(file, '这不是合法 JSON {{{');
  assert.deepEqual(storage.readTaskConventions(taskB), { items: [] });
});
