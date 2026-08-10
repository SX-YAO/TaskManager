/**
 * task:repos — 声明文件写入范围
 *
 * Claude 在首轮回复末尾调用，声明本次任务需要写入文件的目录。
 * 仅在 watchedRepos 为空时调用，已有范围则跳过。
 * 填充 watchedRepos 统一列表，供 diff 查询使用。
 *
 * 注：只有 scopeEnabled=true 时，watchedRepos 才作为 AI 写入约束。
 * 模式 A（scopeEnabled=false）：仅用于 diff 追踪展示，不限制 AI 行为。
 *
 * 协议详情见 PROTOCOL.md
 */

import fs from 'node:fs';
import { addWatchedRepo } from '../taskManager.js';

export default {
  name: 'repos',

  promptText: `
### task:repos — 声明文件写入范围（首轮必要时调用）

若任务涉及多个项目目录，且建任务时未预设写入范围，
请在第一轮回复末尾声明本次任务**需要写入文件**的目录：

<task:repos paths="/path/to/repo1,/path/to/repo2" />

若这些 repo 的基准对比分支不是 main，可指定 baseBranch：
<task:repos paths="/path/to/repo1,/path/to/repo2" baseBranch="develop" />

规则：
- 仅声明需要**修改文件**的目录，只读访问的目录无需声明
- 已有预设范围（watchedRepos 不为空）时跳过，不重复调用
- 若任务目标明确（如 purpose.md 中列出了项目），直接声明
- paths 为英文逗号分隔的绝对路径，每次任务会话只调用一次
`.trim(),

  schema: {
    paths:      { type: 'string', required: true,  description: '英文逗号分隔的绝对路径列表' },
    baseBranch: { type: 'string', required: false, description: '对比基准分支，默认 main' },
  },

  /**
   * @param {{ paths: string, baseBranch?: string }} args
   * @param {{ taskId: string, broadcast: (data: object) => void }} ctx
   */
  handle(args, { taskId, broadcast }) {
    const paths      = args.paths?.split(',').map(p => p.trim()).filter(Boolean) ?? [];
    const baseBranch = args.baseBranch?.trim() || 'master';
    if (!paths.length) return;

    for (const p of paths) {
      if (!fs.existsSync(p)) {
        console.warn(`[tool:repos] 路径不存在，仍添加（可能是计划中的路径）：${p}`);
      }
      addWatchedRepo(taskId, p, baseBranch);
    }

    broadcast({ type: 'repos_updated' });
  },
};
