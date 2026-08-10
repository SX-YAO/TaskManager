/**
 * task:signal — 状态信号工具
 *
 * 最核心的工具，Agent 每轮结束时必须调用一次。
 * 根据 action 参数触发任务状态变更，并通过 WebSocket 通知前端。
 *
 * 协议详情见 PROTOCOL.md
 */

import { updateTaskStatus } from '../taskManager.js';

export default {
  name: 'signal',

  /** 供 index.js 拼装 SYSTEM_PROMPT 用 */
  promptText: `
### task:signal — 状态信号（每轮必须调用）

需要用户确认时（等待用户决策后才能继续）：
<task:signal action="need_confirm" reason="说明需要什么确认" />

本轮完成，有文件改动或产出物：
<task:signal action="done" has_output="true" />

本轮仅对话，无实质改动：
<task:signal action="done" has_output="false" />
`.trim(),

  /**
   * 参数 schema（文档用，非运行时强制验证）
   * 与 PROTOCOL.md 保持一致
   */
  schema: {
    action:     { type: 'enum', values: ['need_confirm', 'done'], required: true },
    reason:     { type: 'string', required: 'when action=need_confirm' },
    has_output: { type: 'bool',   required: 'when action=done' },
  },

  /**
   * 处理器
   * @param {{ action: string, reason?: string, has_output?: string }} args
   * @param {{ taskId: string, broadcast: (data: object) => void }} ctx
   */
  handle(args, { taskId, broadcast }) {
    const { action, reason, has_output } = args;

    if (action === 'need_confirm') {
      if (!reason) {
        console.warn('[tool:signal] need_confirm 缺少 reason 参数，已忽略');
        return;
      }
      updateTaskStatus(taskId, 'pending');
      broadcast({ type: 'status_change', status: 'pending', reason });
      return;
    }

    if (action === 'done') {
      if (has_output === undefined) {
        console.warn('[tool:signal] done 缺少 has_output 参数，已忽略');
        return;
      }
      // 任务一旦运行过就不再回到 idle（idle 是出生态，不是返回态）
      // has_output 只影响前端状态提示条（有/无产出），任务状态统一 reviewing
      updateTaskStatus(taskId, 'reviewing');
      broadcast({ type: 'status_change', status: 'reviewing', hasOutput: has_output === 'true' });
      return;
    }

    console.warn(`[tool:signal] 未知 action: ${action}，已忽略`);
  },
};
