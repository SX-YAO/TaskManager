#!/bin/bash
# Task Manager 快捷启动器
# 双击此文件即可在 Terminal 中启动前后端，并自动打开浏览器

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✦  Task Manager"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

BACKEND_RUNNING=false
FRONTEND_RUNNING=false

lsof -i :7878 -sTCP:LISTEN > /dev/null 2>&1 && BACKEND_RUNNING=true
lsof -i :8787 -sTCP:LISTEN > /dev/null 2>&1 && FRONTEND_RUNNING=true

# 两者都在，直接开浏览器
if $BACKEND_RUNNING && $FRONTEND_RUNNING; then
  echo "✓ 前后端均已运行，直接打开浏览器…"
  open http://localhost:8787
  exit 0
fi

# 初始化数据目录（幂等，已存在时跳过）
node scripts/init.js

# 启动后端（若未运行）
if ! $BACKEND_RUNNING; then
  echo ""
  echo "▶ 启动后端 (port 7878)…"
  node server/index.js &
  BACKEND_PID=$!

  # 等待后端就绪
  for i in $(seq 1 20); do
    if curl -s http://localhost:7878/api/tasks > /dev/null 2>&1; then
      echo "✓ 后端就绪"
      break
    fi
    sleep 0.3
  done
else
  echo "✓ 后端已在运行"
  BACKEND_PID=""
fi

# 启动前端（若未运行）
if ! $FRONTEND_RUNNING; then
  echo "▶ 启动前端 (port 8787)…"
  cd client && npm run dev -- --open &
  FRONTEND_PID=$!
else
  echo "✓ 前端已在运行"
  open http://localhost:8787
  FRONTEND_PID=""
fi

echo ""
echo "✓ Task Manager 已启动"
echo "  浏览器地址：http://localhost:8787"
echo ""
echo "  关闭此窗口即停止所有服务"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 捕获退出信号，关窗口时一并清理子进程
trap "echo ''; echo '正在停止服务…'; [ -n \"$BACKEND_PID\" ] && kill $BACKEND_PID 2>/dev/null; [ -n \"$FRONTEND_PID\" ] && kill $FRONTEND_PID 2>/dev/null; exit 0" SIGINT SIGTERM

# 保持窗口：等待任一已启动的子进程
if [ -n "$BACKEND_PID" ]; then
  wait $BACKEND_PID
elif [ -n "$FRONTEND_PID" ]; then
  wait $FRONTEND_PID
else
  # 两个都是已有进程，保持窗口直到用户关闭
  while true; do sleep 60; done
fi
