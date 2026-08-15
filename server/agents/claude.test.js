import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-toolkey-'));
process.env.TASK_MANAGER_HOME = TMP;

const { toolKey } = await import('./claude.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('signal：只按 action 去重，key 恒为 signal:<action>', () => {
  const a = toolKey({ name: 'signal', args: { action: 'done', has_output: 'true' } });
  const b = toolKey({ name: 'signal', args: { action: 'done', has_output: 'false' } });
  assert.equal(a, 'signal:done');
  assert.equal(a, b);   // close 兜底检查 firedSignals.has('signal:done') 依赖此格式
});

test('convention：不同 text 的 add 生成不同 key（不被误杀）', () => {
  const a = toolKey({ name: 'convention', args: { action: 'add', text: '规范甲' } });
  const b = toolKey({ name: 'convention', args: { action: 'add', text: '规范乙' } });
  assert.notEqual(a, b);
});

test('同轮完全相同的调用 key 一致（仍被去重）', () => {
  const a = toolKey({ name: 'convention', args: { action: 'add', text: '规范甲' } });
  const b = toolKey({ name: 'convention', args: { action: 'add', text: '规范甲' } });
  assert.equal(a, b);
});

test('pitfall：不同 description 生成不同 key', () => {
  const a = toolKey({ name: 'pitfall', args: { type: 'error', description: '甲' } });
  const b = toolKey({ name: 'pitfall', args: { type: 'error', description: '乙' } });
  assert.notEqual(a, b);
});
