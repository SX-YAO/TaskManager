import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-metrics-'));
process.env.TASK_MANAGER_HOME = TMP;

const metrics = await import('./metrics.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('record 追加事件 + summary 聚合', () => {
  metrics.record('tool_call', { tool: 'signal', ok: true });
  metrics.record('tool_call', { tool: 'pitfall', ok: false, error: '缺 description' });
  metrics.record('tool_call', { tool: 'pitfall', ok: true });
  metrics.record('distill_run', { taskId: 't1', added: 2, merged: 1, promoted: 1, zero: false });
  metrics.record('convention_edit', { op: 'update', scope: 'task' });
  metrics.record('digest_inject', { taskId: 't1', bytes: 400 });
  metrics.record('digest_inject', { taskId: 't1', bytes: 600 });

  const s = metrics.summary();
  assert.equal(s.toolCall.total, 3);
  assert.equal(s.toolCall.byTool.pitfall.total, 2);
  assert.ok(Math.abs(s.toolCall.okRate - 2 / 3) < 1e-6);
  assert.equal(s.distill.runs, 1);
  assert.equal(s.distill.produced, 3);        // added + merged
  assert.equal(s.distill.promoted, 1);
  assert.equal(s.conventionEdit.total, 1);
  assert.equal(s.digest.count, 2);
  assert.equal(s.digest.avgBytes, 500);
});

test('summary 空数据不报错', () => {
  fs.rmSync(path.join(TMP, 'metrics'), { recursive: true, force: true });
  const s = metrics.summary();
  assert.equal(s.toolCall.total, 0);
  assert.equal(s.toolCall.okRate, 1);
});

test('超过 5MB 轮转为 events.1.jsonl', () => {
  const file = path.join(TMP, 'metrics', 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1));
  metrics.record('tool_call', { tool: 'signal', ok: true });
  assert.ok(fs.existsSync(path.join(TMP, 'metrics', 'events.1.jsonl')));
  assert.ok(fs.readFileSync(file, 'utf-8').includes('tool_call'));
});
