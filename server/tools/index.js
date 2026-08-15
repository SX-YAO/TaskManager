/**
 * Task Manager · 工具系统入口
 *
 * 职责：
 *   1. 注册所有工具（TOOL_REGISTRY）
 *   2. 提供信号行解析器（parseLine）
 *   3. 提供工具分发器（dispatch）
 *   4. 导出注入 Agent 的系统提示（SYSTEM_PROMPT）
 *
 * 新增工具步骤：
 *   1. 在本目录创建 <name>.js，导出 { name, schema, promptText, handle }
 *   2. 在下方 import 并加入 ALL_TOOLS 数组
 *   3. 在 PROTOCOL.md 的工具目录中添加说明
 *   4. 更新 TOOL_PROTOCOL_VERSION（如协议有破坏性变更）
 *
 * 协议详情见 PROTOCOL.md
 */

import signalTool   from './signal.js';
import progressTool from './progress.js';
import pitfallTool  from './pitfall.js';
import conventionTool from './convention.js';
import reposTool    from './repos.js';

// ── 协议版本（破坏性变更时递增）────────────────────────────────
export const TOOL_PROTOCOL_VERSION = '1.1';

// ── 工具列表（决定注册顺序和 system prompt 拼装顺序）────────────
const ALL_TOOLS = [
  signalTool,
  progressTool,
  pitfallTool,
  conventionTool,
  reposTool,
];

// ── 工具注册表：name → tool ─────────────────────────────────────
export const TOOL_REGISTRY = Object.fromEntries(
  ALL_TOOLS.map(t => [t.name, t])
);

// ── 信号行解析器 ────────────────────────────────────────────────
/**
 * 匹配独占一行的 <task:xxx attr="val" ... /> 标签
 * 严格要求：整行只有这个标签（trim 后）
 */
const TOOL_LINE_RE = /^<task:(\w+)((?:\s+\w+="[^"]*")*)\s*\/>$/;
const ATTR_RE      = /(\w+)="([^"]*)"/g;

/**
 * 解析一行文本，返回工具调用对象或 null
 * @param {string} line
 * @returns {{ name: string, args: Record<string, string> } | null}
 */
export function parseLine(line) {
  const m = line.trim().match(TOOL_LINE_RE);
  if (!m) return null;

  const name = m[1];
  const args = {};
  for (const [, k, v] of m[2].matchAll(ATTR_RE)) args[k] = v;

  return { name, args };
}

// ── 工具分发器 ─────────────────────────────────────────────────
/**
 * 分发工具调用到对应 handler
 * @param {{ name: string, args: Record<string, string> }} tool
 * @param {{ taskId: string, sessionId: string, broadcast: (data: object) => void }} ctx
 */
export function dispatch(tool, ctx) {
  const handler = TOOL_REGISTRY[tool.name];
  if (!handler) {
    // 未知工具：静默忽略，记录 warn（不影响正常流程）
    console.warn(`[tools] 未知工具: task:${tool.name}，已忽略`);
    return;
  }
  try {
    handler.handle(tool.args, ctx);
  } catch (e) {
    console.error(`[tool:${tool.name}] 处理异常:`, e.message);
  }
}

// ── 注入 Agent 的 System Prompt ─────────────────────────────────
/**
 * 由各工具的 promptText 动态拼装，追加到 claude.js 的 SYSTEM_PROMPT 末尾。
 * 格式变化时只需修改各工具文件，这里自动更新。
 */
export const SYSTEM_PROMPT = `
## 任务工具（Task Tools · v${TOOL_PROTOCOL_VERSION}）

你可以在回复中调用以下工具触发后端操作。调用规则：
1. 工具标签必须独占一行，前后不能有其他内容
2. 所有参数值必须用双引号包裹
3. 工具调用对用户不可见，只影响后端状态
4. 每轮对话结束时必须调用 task:signal（done 或 need_confirm 二选一）

${ALL_TOOLS.map(t => t.promptText).join('\n\n')}

重要：参数值只使用中文、字母、数字和基本标点，不使用引号或尖括号。
`.trim();
