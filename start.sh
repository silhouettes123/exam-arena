#!/usr/bin/env bash
# Linux / macOS 一键启动
set -e
cd "$(dirname "$0")"
export PORT="${PORT:-8095}"
echo "考试平台启动中：用户端 http://localhost:$PORT/   管理端 http://localhost:$PORT/admin"
exec node server.js
