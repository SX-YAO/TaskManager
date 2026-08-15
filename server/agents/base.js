/**
 * Agent 统一接口定义（JSDoc 文档，不强制继承）
 *
 * @typedef {Object} Agent
 * @property {function(string, function(string): void, function({sessionId:string,fullText:string}): void): Promise<void>} sendMessage
 * @property {function(): void} stop
 */

/**
 * 创建一个 Agent 实例的工厂函数签名
 * @typedef {function(string, string, string|null): Agent} AgentFactory
 * taskId, projectDir, sessionId(可选)
 */

/**
 * Agent 技能投递模式（声明式能力，新增 agent 时声明即可）：
 *   skillMode: 'native' — 运行时自带 skill 机制（如 Claude Code），
 *                         TaskManager 启动/编辑时把生效版同步到运行时的 skills 目录
 *   skillMode: 'prompt' — 无 skill 机制，适配器把 skillManager.getPromptInjection()
 *                         文本拼进 system prompt，agent 需要时自行 Read 全文
 */

export const AGENT_TYPES = { claude: 'claude' };
