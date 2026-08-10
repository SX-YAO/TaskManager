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

export const AGENT_TYPES = { claude: 'claude' };
