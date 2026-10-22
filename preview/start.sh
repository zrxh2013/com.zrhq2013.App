#!/bin/bash
# 静态预览服务：固定 8899 端口，目录 /workspace/preview
set -e
DIR=/workspace/preview
PORT=8899

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "port ${PORT} already listening"
else
  cd "$DIR"
  setsid nohup python3 -m http.server ${PORT} --bind 0.0.0.0 \
    > /tmp/preview-server.log 2>&1 < /dev/null &
  sleep 1
fi

ss -ltn | grep ":${PORT} "
curl -sI "http://localhost:${PORT}" | head -1
