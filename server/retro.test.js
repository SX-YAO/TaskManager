import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-retro-'));
process.env.TASK_MANAGER_HOME = TMP;

const retro = await import('./retro.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('buildRetroPrompt 含报告分隔符与 promote 输出格式', () => {
  const p = retro.buildRetroPrompt('11111111-2222-4333-8444-555555555555');
  assert.ok(p.includes('===REPORT==='));
  assert.ok(p.includes('action="promote"'));
  assert.ok(p.includes('11111111-2222-4333-8444-555555555555'));
});

test('readArchiveMaterials 目录缺失容错', () => {
  const m = retro.readArchiveMaterials('99999999-9999-4999-8999-999999999999');
  assert.deepEqual(m.pitfalls, []);
  assert.deepEqual(m.conventions, []);
});

test('writeRetroReport 写入归档目录', () => {
  const taskId = '11111111-2222-4333-8444-555555555555';
  const dir = path.join(TMP, 'archive', taskId, 'artifacts', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  retro.writeRetroReport(taskId, '标签行\n===REPORT===\n# 复盘正文');
  const content = fs.readFileSync(path.join(dir, 'retrospective.md'), 'utf-8');
  assert.ok(content.includes('复盘正文'));
  assert.ok(!content.includes('===REPORT==='));
});

test('writeRetroReport 无分隔符不写文件', () => {
  const taskId = '22222222-2222-4222-8222-222222222222';
  retro.writeRetroReport(taskId, '没有分隔符的文本');
  assert.ok(!fs.existsSync(path.join(TMP, 'archive', taskId, 'artifacts', 'reports', 'retrospective.md')));
});
