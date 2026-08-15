---
name: task-discipline
description: 长任务纪律：进度更新、踩坑记录、规范查阅的质量标准与触发时机。在 TaskManager 长任务中工作时使用。
version: 1.1
---

# 任务纪律（Task Discipline）

你在 TaskManager 的长任务中工作。长任务会跨多轮、多会话，本技能定义防止行为漂移的纪律。

## 开工必读

1. `.task-manager/{taskId}/purpose.md` — 任务目的与验收标准
2. `.task-manager/{taskId}/progress.json` — 当前执行进度
3. `.task-manager/{taskId}/pitfalls.json` — 历史踩坑记录
4. 规范：本任务 `.task-manager/{taskId}/conventions.json` + 全局 `~/.task-manager/conventions.json`
   （均为 { items: [...] }；candidate=false 的条目严格遵守，candidate=true 为待确认候选，参考遵守）

{taskId} 以系统提示给出的任务目录为准。

## 细则索引

- 进度更新质量标准 → progress-guide.md（同目录）
- 踩坑记录质量标准 → pitfall-guide.md（同目录）

## 行为红线

- 完工（task:signal done）前，对照 purpose.md 验收标准逐条自查
- 不扩大任务范围：发现计划外改动需求，先告知用户确认
- 即将修改的文件若出现在 pitfalls.json 中，先读完整踩坑记录再动手
- 与用户争论技术方案前，先查 conventions 是否已有约定
- 每轮结束必须 task:signal；有进展必须 task:progress；踩坑必须 task:pitfall
- 用户陈述了工作习惯/团队约定时，用 task:convention 上报
