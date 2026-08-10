import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-taskmgr-'));
process.env.TASK_MANAGER_HOME = TMP;

const tm = await import('./taskManager.js');
const { readMeta, writeMeta, appendMessage } = await import('./storage.js');

const PROJECT = path.join(TMP, 'proj');
let taskId;

before(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  taskId = tm.createTask({ title: 't', projectDir: PROJECT, purpose: 'p' }).id;
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('新任务自带 main 主会话', () => {
  const sessions = tm.listSessions(taskId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'main');
  assert.equal(sessions[0].isMain, true);
  assert.equal(sessions[0].status, 'idle');
});

test('createSession 默认名 会话 N，可改名', () => {
  const s1 = tm.createSession(taskId);
  assert.equal(s1.name, '会话 2');
  const s2 = tm.createSession(taskId, '方案B');
  assert.equal(s2.name, '方案B');
  assert.equal(s2.isMain, false);
  const renamed = tm.renameSession(taskId, s1.id, '改名了');
  assert.equal(renamed.name, '改名了');
});

test('closeSession：主会话拒绝，子会话可关闭', () => {
  assert.throws(() => tm.closeSession(taskId, 'main'), /主会话不可关闭/);
  const s = tm.listSessions(taskId).find(x => !x.isMain);
  const closed = tm.closeSession(taskId, s.id);
  assert.equal(closed.status, 'closed');
  assert.ok(closed.closedAt);
});

test('aggregateStatus：优先级聚合 running > pending > reviewing > 主会话', () => {
  const meta = readMeta(taskId);
  // 当前无 running → 主会话 idle
  assert.equal(tm.aggregateStatus(meta), 'idle');
  const sub = tm.listSessions(taskId).find(x => !x.isMain && x.status !== 'closed');
  tm.updateSessionStatus(taskId, sub.id, 'running');
  assert.equal(tm.aggregateStatus(readMeta(taskId)), 'running');
  tm.updateSessionStatus(taskId, sub.id, 'reviewing');
  // 新规则分歧场景：main idle + 子会话 pending → pending（旧规则会得 idle）
  tm.updateSessionStatus(taskId, sub.id, 'pending');
  assert.equal(tm.aggregateStatus(readMeta(taskId)), 'pending');
  // 还原：子会话 reviewing、主会话 pending
  tm.updateSessionStatus(taskId, sub.id, 'reviewing');
  tm.updateSessionStatus(taskId, 'main', 'pending');
  assert.equal(tm.aggregateStatus(readMeta(taskId)), 'pending');
});

test('getTask 返回派生 status', () => {
  const t = tm.getTask(taskId);
  assert.equal(t.status, 'pending'); // 主会话刚置为 pending
  assert.ok(Array.isArray(t.sessions));
});

test('setSessionSid：旧 sid 归档 sessionHistory', () => {
  tm.setSessionSid(taskId, 'main', 'sid-1', 100, 200000);
  tm.setSessionSid(taskId, 'main', 'sid-2', 200, 200000);
  const s = tm.getSession(taskId, 'main');
  assert.equal(s.claudeSessionId, 'sid-2');
  assert.equal(s.contextTokens, 200);
  assert.equal(s.sessionHistory.length, 1);
  assert.equal(s.sessionHistory[0].sid, 'sid-1');
});

test('migrateLegacyTask：旧格式合成 main 会话并迁移消息', () => {
  // 手工构造旧格式 meta（无 sessions 字段）
  const legacy = tm.createTask({ title: '旧', projectDir: PROJECT, purpose: 'p' });
  const meta = readMeta(legacy.id);
  delete meta.sessions;
  meta.claudeSessionId = 'old-sid';
  meta.contextTokens = 500;
  meta.status = 'reviewing';
  writeMeta(legacy.id, meta);
  appendMessage(legacy.id, { role: 'user', content: 'legacy-msg', timestamp: 't', toolCalls: [] });

  assert.equal(tm.migrateLegacyTask(legacy.id), true);
  const s = tm.getSession(legacy.id, 'main');
  assert.equal(s.claudeSessionId, 'old-sid');
  assert.equal(s.contextTokens, 500);
  assert.equal(s.status, 'reviewing');
  // 幂等
  assert.equal(tm.migrateLegacyTask(legacy.id), false);
});

test('listRunningSessions 只含 running 且非 closed 的会话', () => {
  const running = tm.listRunningSessions();
  for (const r of running) {
    const s = tm.getSession(r.taskId, r.sessionId);
    assert.equal(s.status, 'running');
  }
});
