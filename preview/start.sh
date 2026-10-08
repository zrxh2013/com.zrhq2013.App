#!/bin/bash
# 闪应用预览服务启动脚本（端口 8899，沙箱重启后需重新执行一次）
cd "$(dirname "$0")"
if ss -ltn 2>/dev/null | grep -q ':8899 '; then
  echo "预览服务已在运行: http://localhost:8899"
  exit 0
fi
setsid nohup python3 -m http.server 8899 --bind 0.0.0.0 > /tmp/preview-server.log 2>&1 < /dev/null &
sleep 1
if ss -ltn 2>/dev/null | grep -q ':8899 '; then
  echo "已启动: http://localhost:8899 (PID $!)"
else
  echo "启动失败，日志："; cat /tmp/preview-server.log; exit 1
fi
