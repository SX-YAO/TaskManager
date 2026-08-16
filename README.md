# Task Manager

以**任务为维度**的 AI 长任务管理器。为每个任务提供独立的 AI 会话、进度追踪、踩坑记录、规范沉淀与代码改动监控，解决长任务中 AI 行为漂移、上下文遗忘的问题。

## 特性

- **多会话管理**：每个任务可开多个 AI 会话，会话标签栏切换 / 新建 / 改名 / 关闭，支持拖拽双栏分屏对比不同方案
- **任务纪律 Skill**：进度更新、踩坑日记、开发规范的沉淀体系——服务端自动蒸馏用户规范（任务级 + 全局两级存储，可晋升/降级），每轮对话注入纪律简报，约束 AI 行为
- **改动范围监控**：声明/固定 AI 的写入目录，实时 git diff 追踪，支持写入约束模式
- **产出物面板**：任务产生的报告、方案文档统一归档查看
- **技能管理**：技能以多文件目录形式管理（SKILL.md 入口 + 子文档），用户可按文件粒度覆盖默认版本，内置可视化编辑器
- **实时交互**：WebSocket 流式输出，支持中断、手动重开会话
- **Agent 抽象层**：不绑定特定 AI——新增 Agent 只需在 `server/agents/` 实现 `start / sendMessage / stop` 接口（当前内置 Claude 实现）

## 架构

```
client/   Vue 3 + Vite 前端（端口 8787）
server/   Node.js + Express 后端（端口 7878）
  agents/   Agent 抽象层（继承 base.js）
  skills/   内置技能（task-discipline）
  tools/    task:* 工具体系（进度/踩坑/规范/信号…）
```

数据持久化在 `~/.task-manager/`（任务、归档、全局规范、埋点指标），不污染你的项目目录；任务相关的工作文件在任务目录下的 `.task-manager/{taskId}/`。

## 前置要求

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（默认 Agent，可在设置中配置其他命令）

## 安装与启动

```bash
npm install && (cd client && npm install)
npm run init   # 首次运行，初始化数据目录
npm run dev    # 同时启动前后端
```

macOS 也可以直接双击 `start.command`，一键启动并打开浏览器。

打开 http://localhost:8787 ，新建任务即可开始。

## 测试

```bash
npm test
```

## License

[MIT](LICENSE)
