/**
 * task:convention — 规范上报工具
 *
 * 双通道：任务 agent 主动上报（ctx.origin='agent'）+ 服务端蒸馏器（ctx.origin='distill'）。
 * 蒸馏器无删除权——删除只走人工 UI。
 *
 * 协议详情见 PROTOCOL.md
 */

import { addTaskEntry, mergeTaskEntry, promoteToGlobal } from '../conventions.js';

export default {
  name: 'convention',

  promptText: `
### task:convention — 发现用户的工作习惯/团队约定时上报
<task:convention action="add" text="规范内容" />
`.trim(),

  schema: {
    action:    { type: 'enum', values: ['add', 'merge', 'promote'], required: true },
    text:      { type: 'string', required: true },
    candidate: { type: 'bool',   required: false, description: '疑似通用规范（蒸馏器用）' },
    target:    { type: 'string', required: false, description: 'merge 的 1-based 序号（蒸馏器用）' },
    sources:   { type: 'string', required: false, description: 'promote 的来源任务 id 逗号列表（蒸馏器用）' },
  },

  /**
   * @param {{ action: string, text?: string, candidate?: string, target?: string, sources?: string }} args
   * @param {{ taskId: string, origin?: string }} ctx
   * @returns {undefined | { error: string }}
   */
  handle(args, { taskId, origin = 'agent' }) {
    const { action, text = '', candidate, target, sources } = args;

    if (action === 'add') {
      if (!text) return { error: 'add 缺少 text' };
      addTaskEntry(taskId, { text, candidate: candidate === 'true', origin, sources: [taskId] });
      return;
    }

    if (action === 'merge') {
      const ord = parseInt(target, 10);
      if (!text || !Number.isInteger(ord)) return { error: 'merge 需要 target(序号) 与 text' };
      const r = mergeTaskEntry(taskId, ord, text,
        { candidate: candidate === undefined ? undefined : candidate === 'true' });
      if (r.error) return { error: r.error };
      return;
    }

    if (action === 'promote') {
      if (!text) return { error: 'promote 缺少 text' };
      const srcList = sources ? sources.split(',').map(s => s.trim()).filter(Boolean) : [];
      promoteToGlobal(text, srcList.length ? srcList : [taskId], origin);
      return;
    }

    return { error: `未知 action: ${action}` };
  },
};
