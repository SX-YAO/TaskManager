import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-api-'));
process.env.TASK_MANAGER_HOME = TMP;

const { createTask } = await import('./taskManager.js');
const router = (await import('./router.js')).default;

const PROJECT = path.join(TMP, 'proj');
let taskId, base, server;

before(async () => {
  fs.mkdirSync(PROJECT, { recursive: true });
  taskId = createTask({ title: 't', projectDir: PROJECT, purpose: 'p' }).id;
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const j = (r) => r.json();

test('任务级规范 CRUD + promote', async () => {
  const add = await fetch(`${base}/tasks/${taskId}/conventions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '任务级规范甲' }),
  }).then(j);
  assert.equal(add.text, '任务级规范甲');
  assert.equal(add.origin, 'human');

  let list = await fetch(`${base}/tasks/${taskId}/conventions`).then(j);
  assert.equal(list.length, 1);

  await fetch(`${base}/tasks/${taskId}/conventions/${add.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '任务级规范甲改' }),
  });
  list = await fetch(`${base}/tasks/${taskId}/conventions`).then(j);
  assert.equal(list[0].text, '任务级规范甲改');

  await fetch(`${base}/tasks/${taskId}/conventions/${add.id}/promote`, { method: 'POST' });
  list = await fetch(`${base}/tasks/${taskId}/conventions`).then(j);
  assert.equal(list.length, 0);
  const globals = await fetch(`${base}/conventions`).then(j);
  const g = globals.find(e => e.text === '任务级规范甲改');
  assert.ok(g && g.candidate === false);

  await fetch(`${base}/conventions/${g.id}`, { method: 'DELETE' });
});

test('全局规范新增/confirm/demote', async () => {
  const add = await fetch(`${base}/conventions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '全局规范乙' }),
  }).then(j);
  assert.equal(add.candidate, false);

  // demote 需要 taskId
  const bad = await fetch(`${base}/conventions/${add.id}/demote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(bad.status, 400);
  await fetch(`${base}/conventions/${add.id}/demote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  const taskList = await fetch(`${base}/tasks/${taskId}/conventions`).then(j);
  assert.ok(taskList.some(e => e.text === '全局规范乙'));
  await fetch(`${base}/tasks/${taskId}/conventions/${taskList[0].id}`, { method: 'DELETE' });
});

test('skills tree/file 读写 + SKILL.md 校验', async () => {
  const skills = await fetch(`${base}/skills`).then(j);
  assert.ok(skills.some(s => s.name === 'task-discipline'));

  const tree = await fetch(`${base}/skills/task-discipline/tree`).then(j);
  assert.equal(tree.length, 3);

  const f = await fetch(`${base}/skills/task-discipline/file?path=SKILL.md`).then(j);
  assert.equal(f.source, 'default');
  assert.ok(f.content.includes('task-discipline'));

  const badPut = await fetch(`${base}/skills/task-discipline/file?path=SKILL.md`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# 无头' }),
  });
  assert.equal(badPut.status, 400);

  await fetch(`${base}/skills/task-discipline/file?path=notes.md`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# 笔记' }),
  });
  const tree2 = await fetch(`${base}/skills/task-discipline/tree`).then(j);
  assert.equal(tree2.find(x => x.path === 'notes.md').source, 'new');

  await fetch(`${base}/skills/task-discipline/file?path=notes.md`, { method: 'DELETE' });
  const tree3 = await fetch(`${base}/skills/task-discipline/tree`).then(j);
  assert.equal(tree3.find(x => x.path === 'notes.md'), undefined);
});

test('metrics/summary 返回聚合结构', async () => {
  const s = await fetch(`${base}/metrics/summary`).then(j);
  assert.ok('toolCall' in s && 'distill' in s && 'editRate' in s && 'digest' in s);
});
