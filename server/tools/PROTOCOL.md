# Task Manager · Agent 工具协议规范

**版本**：1.1  
**适用**：所有 Agent 实现（当前：Claude CLI）

---

## 协议原理

Agent（AI）通过在回复文本中输出特定格式的标签来触发后端系统动作。  
后端实时扫描 Agent 的输出流，检测到标签后立即处理，**标签本身不展示给用户**。

这与 Anthropic API 的 tool_use 机制本质相同——都是"文本协议上的结构化调用"，  
区别仅在于我们用 XML 标签代替了 JSON block，无需修改底层 Agent 接入方式即可实现。

---

## 标签格式

```
<task:工具名 参数名="参数值" ... />
```

### 格式约束（全部满足才处理，否则忽略）

| 约束 | 说明 |
|------|------|
| 独占一行 | 标签所在行不能有其他内容 |
| 命名空间 | 必须以 `task:` 开头 |
| 自闭合 | 必须以 `/>` 结尾 |
| 参数引号 | 所有参数值必须用双引号包裹 |
| 参数字符 | 参数值不含双引号、尖括号 |

### 合法示例

```xml
<task:signal action="need_confirm" reason="请确认要删除旧接口" />
<task:signal action="done" has_output="true" />
<task:progress summary="接口拆分完成" completed="分析调用链,拆分接口" pending="接入MQ,写测试" />
<task:pitfall type="error" description="MQ重复消费" solution="幂等锁key=refundId" />
```

### 非法示例（后端忽略）

```xml
已完成。<task:signal action="done" />        ← 不在独占行
<signal action="done" />                      ← 缺少命名空间
<task:signal action=done />                   ← 参数值未加引号
```

---

## 工具目录

### task:signal · 状态信号

**最核心工具，每轮对话结束时必须调用一次。**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum | ✅ | `need_confirm` \| `done` |
| `reason` | string | need_confirm 时必填 | 向用户展示的原因，不含引号/尖括号 |
| `has_output` | bool | done 时必填 | 本轮是否有实质产出（文件改动/产出物） |

状态跳转：

```
action=need_confirm              → pending（待确认）
action=done, has_output=true    → reviewing（验收中）
action=done, has_output=false   → idle（维持未运行）
```

使用时机：
- `need_confirm`：需要用户做决策才能继续（选方案、确认删除、授权操作等）
- `done`：本轮所有工作完成，进入等待

```xml
<task:signal action="need_confirm" reason="检测到两种方案，请确认使用哪个" />
<task:signal action="done" has_output="true" />
<task:signal action="done" has_output="false" />
```

---

### task:progress · 进度更新

有进度变化时调用，更新任务执行进度。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `summary` | string | ✅ | 当前进度概要（一句话） |
| `completed` | string | 否 | 已完成步骤，逗号分隔 |
| `pending` | string | 否 | 待完成步骤，逗号分隔 |

```xml
<task:progress summary="接口拆分完成，MQ接入中" completed="分析调用链,拆分接口" pending="接入MQ,写测试,压测" />
```

---

### task:pitfall · 踩坑记录

遇到错误或积累经验时调用，追加到踩坑日记。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | enum | ✅ | `error` \| `lesson` |
| `description` | string | ✅ | 问题描述 |
| `solution` | string | 否 | 解决方案 |

```xml
<task:pitfall type="error" description="MQ消费端重复消费" solution="幂等锁key=refundId TTL=24h" />
```

---

### task:convention · 规范上报

Agent 发现用户的工作习惯/团队约定时上报；服务端蒸馏器也用此工具写入蒸馏结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| action | enum | 是 | add（新增任务级）/ merge（合并进序号条目）/ promote（晋升全局） |
| text | string | 是 | 规范内容，单行 |
| candidate | bool | 否 | 疑似通用规范（仅蒸馏器） |
| target | string | 否 | merge 目标的 1-based 序号（仅蒸馏器） |
| sources | string | 否 | promote 来源任务 id 逗号列表（仅蒸馏器） |

示例：`<task:convention action="add" text="提交前必须跑 npm test" />`

---

## System Prompt（注入 Agent 的完整文本）

> 以下是 `index.js` 中 `SYSTEM_PROMPT` 的原文内容，由代码动态组装。  
> 每次新增工具后，对应的 `promptText` 会自动拼入。

```
## 任务工具（Task Tools · v1.0）

你可以在回复中调用以下工具触发后端操作。调用规则：
1. 工具标签必须独占一行，前后不能有其他内容
2. 所有参数值必须用双引号包裹
3. 工具调用对用户不可见，只影响后端状态
4. 每轮对话结束时必须调用 task:signal（done 或 need_confirm 二选一）

### task:signal — 状态信号（每轮必须调用）

需要用户确认时：
<task:signal action="need_confirm" reason="说明需要什么确认" />

本轮完成，有文件改动或产出物：
<task:signal action="done" has_output="true" />

本轮仅对话，无实质改动：
<task:signal action="done" has_output="false" />

### task:progress — 有进度变化时更新
<task:progress summary="概要" completed="步骤1,步骤2" pending="步骤3" />

### task:pitfall — 遇到错误或经验时记录
<task:pitfall type="error" description="问题描述" solution="解决方案" />

重要：reason/description/solution 参数值只使用中文、字母、数字和基本标点，不使用引号或尖括号。
```

---

## 扩展协议（未来路径）

当切换到 Anthropic API 直连（而非 CLI）时，上述文本协议可直接升级为 API Tool Use：

```json
{
  "name": "task__signal",
  "description": "触发任务状态变更",
  "input_schema": {
    "type": "object",
    "properties": {
      "action":     { "type": "string", "enum": ["need_confirm", "done"] },
      "reason":     { "type": "string" },
      "has_output": { "type": "boolean" }
    },
    "required": ["action"]
  }
}
```

后端 `dispatch()` 函数接口不变，只改解析层。**协议 key 名与参数保持一致，切换时业务逻辑零改动。**
