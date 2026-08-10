import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 必须在 import storage 前设置（storage 读取此环境变量确定数据根目录）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-storage-'));
process.env.TASK_MANAGER_HOME = TMP;

const { initTaskFiles, appendSessionMessage, readSessionMessages,
        appendMessage, migrateLegacyMessages, readMeta } = await import('./storage.js');

const TASK_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT = path.join(TMP, 'proj');

before(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  initTaskFiles(TASK_ID, { title: 't', projectDir: PROJECT, purpose: 'p' });
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('appendSessionMessage / readSessionMessages 按会话隔离', () => {
  appendSessionMessage(TASK_ID, 'main', { role: 'user', content: 'main-msg', timestamp: 't1', toolCalls: [] });
  appendSessionMessage(TASK_ID, 'main', { role: 'assistant', content: 'main-reply', timestamp: 't2', toolCalls: [] });
  const SUB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  appendSessionMessage(TASK_ID, SUB, { role: 'user', content: 'sub-msg', timestamp: 't3', toolCalls: [] });

  const mainMsgs = readSessionMessages(TASK_ID, 'main');
  assert.equal(mainMsgs.length, 2);
  assert.equal(mainMsgs[0].content, 'main-msg');
  const subMsgs = readSessionMessages(TASK_ID, SUB);
  assert.equal(subMsgs.length, 1);
  assert.equal(subMsgs[0].content, 'sub-msg');
});

test('readSessionMessages 无文件时返回空数组', () => {
  assert.deepEqual(readSessionMessages(TASK_ID, 'aaaaaaaa-0000-4000-8000-000000000000'), []);
});

test('非法 sessionId 抛错', () => {
  assert.throws(() => readSessionMessages(TASK_ID, '../etc'));
});

test('migrateLegacyMessages 把根目录 messages.jsonl 移入 sessions/main/', () => {
  // 旧格式：根目录直接写消息
  appendMessage(TASK_ID, { role: 'user', content: 'legacy', timestamp: 't0', toolCalls: [] });
  const moved = migrateLegacyMessages(TASK_ID);
  assert.equal(moved, true);
  const msgs = readSessionMessages(TASK_ID, 'main');
  assert.ok(msgs.some(m => m.content === 'legacy'));
  // 幂等：再迁移一次返回 false，消息不重复
  assert.equal(migrateLegacyMessages(TASK_ID), false);
  assert.equal(readSessionMessages(TASK_ID, 'main').filter(m => m.content === 'legacy').length, 1);
});
