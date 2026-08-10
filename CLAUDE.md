# Task Manager 项目说明

## 项目结构
- client/   Vue 3 + Vite 前端（端口 8787）
- server/   Node.js + Express 后端（端口 7878）
  - agents/ Agent 抽象层，新增 Agent 在此目录添加实现，继承 base.js 接口

## 开发约定
- 任务数据读写统一通过 storage.js，不直接操作文件
- Agent 实现必须导出 start / sendMessage / stop 三个方法
- WebSocket 消息格式：每条消息是 JSON 对象，type 字段区分类型

## 数据目录
~/.task-manager/tasks/{id}/  任务持久化根目录
~/.task-manager/config.json  全局配置（maxConcurrency 等）

## 启动
npm run init   # 首次运行，初始化数据目录
npm run dev    # 同时启动前后端
