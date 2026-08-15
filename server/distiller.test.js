import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-distill-'));
process.env.TASK_MANAGER_HOME = TMP;

const { createTask } = await import('./taskManager.js');
const conv = await import('./conventions.js');
const d = await import('./distiller.js');

const PROJECT = path.join(TMP, 'proj');
let taskId, taskB;

before(() => {
  fs.mkdirSync(PROJECT, { recursive: true });
  taskId = createTask({ title: 'a', projectDir: PROJECT, purpose: 'p' }).id;
  taskB  = createTask({ title: 'b', projectDir: PROJECT, purpose: 'p' }).id;
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('buildDistillPrompt 含判定标准与编号列表；全局 ≥50 条时加合并要求', () => {
  conv.addTaskEntry(taskId, { text: '已有规范甲', origin: 'human' });
  const p = d.buildDistillPrompt({
    taskEntries: conv.listTaskConventions(taskId),
    otherCandidates: [{ taskId: taskB, text: '他任务候选' }],
    globalEntries: [],
    cap: false,
  });
  assert.ok(p.includes('candidate="true"'));
  assert.ok(p.includes('已有规范甲'));
  assert.ok(p.includes('他任务候选'));
  assert.ok(!p.includes('已超过 50'));
  const p2 = d.buildDistillPrompt({ taskEntries: [], otherCandidates: [], globalEntries: [], cap: true });
  assert.ok(p2.includes('已超过 50'));
});

test('parseToolOutput：标签行分发写入，其余行收集为 text', () => {
  const before = conv.listTaskConventions(taskId).length;
  const out = [
    '一些说明文字',
    `<task:convention action="add" text="蒸馏新规范" candidate="true" />`,
    '===REPORT===',
    '报告正文',
  ].join('\n');
  const r = d.parseToolOutput(out, { taskId, origin: 'distill', broadcast: () => {} });
  assert.equal(r.counts.add, 1);
  assert.ok(r.text.includes('报告正文'));
  assert.ok(!r.text.includes('task:convention'));
  assert.equal(conv.listTaskConventions(taskId).length, before + 1);
  assert.ok(conv.listTaskConventions(taskId).some(e => e.text === '蒸馏新规范' && e.candidate === true));
});

test('parseToolOutput：垃圾输出静默（无标签不报错）', () => {
  const r = d.parseToolOutput('完全无关的输出\n没有标签', { taskId, origin: 'distill', broadcast: () => {} });
  assert.equal(r.counts.add + r.counts.merge + r.counts.promote, 0);
});

test('scheduleDistill 空消息直接返回', () => {
  assert.equal(d.scheduleDistill(taskId, ''), undefined);
  assert.equal(d.scheduleDistill(taskId, null), undefined);
});
