import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-signal-'));
process.env.TASK_MANAGER_HOME = TMP;

const signal = (await import('./signal.js')).default;
const tm = await import('../taskManager.js');

const PROJECT = path.join(TMP, 'proj');
let taskId, subId;
const sent = [];
const broadcast = (d) => sent.push(d);

before(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  taskId = tm.createTask({ title: 't', projectDir: PROJECT, purpose: 'p' }).id;
  subId = tm.createSession(taskId).id;
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('need_confirm → 会话 pending + 双广播', () => {
  sent.length = 0;
  signal.handle({ action: 'need_confirm', reason: '选方案' }, { taskId, sessionId: subId, broadcast });
  assert.equal(tm.getSession(taskId, subId).status, 'pending');
  assert.deepEqual(sent[0], { type: 'session_status_change', sessionId: subId, status: 'pending', reason: '选方案' });
  assert.deepEqual(sent[1], { type: 'status_change', status: 'pending' });
});

test('done has_output=true → 会话 reviewing，聚合态 running 优先', () => {
  sent.length = 0;
  tm.updateSessionStatus(taskId, 'main', 'running');
  signal.handle({ action: 'done', has_output: 'true' }, { taskId, sessionId: subId, broadcast });
  assert.equal(tm.getSession(taskId, subId).status, 'reviewing');
  assert.equal(sent[0].type, 'session_status_change');
  assert.deepEqual(sent[1], { type: 'status_change', status: 'running' }); // main 还 running
});
