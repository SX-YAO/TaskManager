# server/tools · 工具系统

> ⚠️ **这是 Task Manager 的核心基础设施。**  
> 工具系统定义了 AI Agent 与系统状态之间的交互协议，  
> 修改前请通读本文件和 PROTOCOL.md。

---

## 是什么

Task Manager 建立了一套**基于文本的工具调用协议**：

Agent 在回复正文中输出特定格式的 XML 标签 →  
后端实时扫描输出流，检测到标签后执行对应动作 →  
标签本身从用户可见文本中剥离，不展示给用户。

这与 Anthropic API 的 `tool_use` 机制原理完全相同，  
区别在于我们通过文本协议实现，无需改变底层 Agent（Claude CLI）的接入方式。

---

## 目录结构

```
server/tools/
├── README.md      ← 当前文件，开发者必读
├── PROTOCOL.md    ← 协议规范（AI 可读），包含完整 system prompt 原文
├── index.js       ← 入口：parseLine / dispatch / SYSTEM_PROMPT / TOOL_REGISTRY
├── signal.js      ← task:signal   状态信号（最核心）
├── progress.js    ← task:progress 进度更新
└── pitfall.js     ← task:pitfall  踩坑记录
```

---

## 当前工具一览

| 工具 | 触发时机 | 系统动作 |
|------|---------|---------|
| `task:signal need_confirm` | Agent 需要用户决策 | 状态 → `pending`，广播通知 |
| `task:signal done` | Agent 本轮工作完成 | 状态 → `reviewing` 或 `idle` |
| `task:progress` | 进度有变化 | 写入 `progress.json` |
| `task:pitfall` | 遇到错误或总结经验 | 追加到 `pitfalls.json` |

---

## 核心模块说明

### `parseLine(line: string)`

解析一行文本，返回工具调用对象或 null。

```js
parseLine('<task:signal action="done" has_output="true" />')
// → { name: 'signal', args: { action: 'done', has_output: 'true' } }

parseLine('普通文本')
// → null
```

### `dispatch(tool, ctx)`

将解析出的工具调用分发到对应 handler。

```js
dispatch(
  { name: 'signal', args: { action: 'done', has_output: 'true' } },
  { taskId: 'xxx', broadcast: fn }
);
```

### `SYSTEM_PROMPT`

注入 Agent 的完整工具说明文本，由所有工具的 `promptText` 动态拼装。  
在 `agents/claude.js` 中通过 `--append-system-prompt` 注入。

### `TOOL_REGISTRY`

工具名 → 工具对象的映射表。`dispatch` 用它查找对应 handler。

---

## 如何新增工具

> 新增工具是**协议变更**，需谨慎对待。确认协议稳定后再实现。

**步骤：**

1. **设计协议**：在 PROTOCOL.md 的「工具目录」中添加完整的参数定义和使用说明

2. **创建工具文件** `server/tools/<name>.js`，导出以下接口：

```js
export default {
  name: 'myTool',           // 工具名，对应 <task:myTool />

  promptText: `             // 注入 Agent 的说明文本（Markdown 格式）
### task:myTool — 描述
<task:myTool param="值" />
`.trim(),

  schema: {                 // 参数定义（文档用）
    param: { type: 'string', required: true, description: '...' },
  },

  handle(args, ctx) {       // 执行逻辑
    // ctx: { taskId, broadcast }
    // args: 解析出的参数 Record<string, string>
  },
};
```

3. **注册到 index.js**：
   - `import myTool from './myTool.js'`
   - 加入 `ALL_TOOLS` 数组

4. **更新 TOOL_PROTOCOL_VERSION**（若有破坏性变更）

5. **测试**：确认 Agent 能正确触发工具，后端正确处理

---

## 可靠性设计

| 机制 | 实现位置 | 说明 |
|------|---------|------|
| **幂等性** | `agents/claude.js` | 同一轮同一 action 只处理第一次 |
| **格式容错** | `parseLine()` | 非法格式静默忽略，不影响正常文本推送 |
| **降级处理** | `agents/claude.js` | 进程正常退出但无 done 信号时自动补发 |
| **错误隔离** | `dispatch()` | 单个工具 handler 异常不影响其他工具 |

---

## 未来扩展路径

当切换到 Anthropic API 直连时，本目录的工具定义可直接映射为 API Tool Schema：

```js
// 从工具文件的 schema 生成 API Tool 定义
// dispatch() 接口不变，只改 agents/claude.js 的解析层
```

详见 PROTOCOL.md「扩展协议」章节。
