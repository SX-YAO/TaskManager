/**
 * task:progress — 进度更新工具
 *
 * 有进度变化时调用，覆盖写入 progress.json。
 * 替代 Agent 直接用 Write 工具操作文件的方式，更可靠、可追踪。
 *
 * 协议详情见 PROTOCOL.md
 */

import { writeProgress } from '../storage.js';

export default {
  name: 'progress',

  promptText: `
### task:progress — 完成阶段性进展或待办变化时更新（覆盖写）
<task:progress summary="当前进度概要" completed="步骤1,步骤2" pending="步骤3,步骤4" />
pending 必须写到「可接力」颗粒度，质量标准见 task-discipline skill。
`.trim(),

  schema: {
    summary:   { type: 'string', required: true },
    completed: { type: 'string', required: false, description: '逗号分隔的已完成步骤' },
    pending:   { type: 'string', required: false, description: '逗号分隔的待完成步骤，写到可接力颗粒度' },
  },

  /**
   * @param {{ summary: string, completed?: string, pending?: string }} args
   * @param {{ taskId: string }} ctx
   */
  handle(args, { taskId }) {
    const { summary = '', completed = '', pending: pend = '' } = args;
    if (!summary) return { error: '缺少 summary' };

    const completedSteps = completed
      ? completed.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const pendingSteps = pend
      ? pend.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    writeProgress(taskId, {
      summary,
      completedSteps,
      pendingSteps,
      updatedAt: new Date().toISOString(),
    });
  },
};
