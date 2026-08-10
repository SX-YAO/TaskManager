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
### task:progress — 有进度变化时更新
<task:progress summary="当前进度概要" completed="步骤1,步骤2" pending="步骤3,步骤4" />

pending 写到「可接力」颗粒度：每个待办步骤要能让一个全新会话（无对话历史）读懂并直接动手。
格式建议：步骤名 + 关键文件路径 + 卡点/下一步具体动作。例：
pending="修复 login 403：src/api/login.ts 的 token 刷新逻辑，卡在 refreshToken 未触发；改完跑 npm test"
上下文超阈值时会自动重开会话，新会话只读 purpose/progress/pitfalls 恢复，pending 是接力的命脉。
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
