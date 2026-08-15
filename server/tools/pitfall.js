/**
 * task:pitfall — 踩坑记录工具
 *
 * 遇到错误或总结经验时调用，追加到 pitfalls.json。
 * 替代 Agent 直接操作文件，保证格式一致且可追踪。
 *
 * 协议详情见 PROTOCOL.md
 */

import { appendPitfall } from '../storage.js';

export default {
  name: 'pitfall',

  promptText: `
### task:pitfall — 遇到错误或总结经验时记录
<task:pitfall type="error" description="现象+根因+关联文件" solution="解决+预防" />
质量标准（五要素）见 task-discipline skill。
`.trim(),

  schema: {
    type:        { type: 'enum', values: ['error', 'lesson'], required: true },
    description: { type: 'string', required: true },
    solution:    { type: 'string', required: false },
  },

  /**
   * @param {{ type: string, description: string, solution?: string }} args
   * @param {{ taskId: string }} ctx
   */
  handle(args, { taskId }) {
    const { type = 'error', description, solution = '' } = args;

    if (!description) return { error: '缺少 description' };

    appendPitfall(taskId, {
      timestamp: new Date().toISOString(),
      type,
      description,
      solution,
    });
  },
};
