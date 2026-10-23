#!/usr/bin/env bash
set -euo pipefail

# Fastify 健康检查脚本
# 返回 0 = 健康，非 0 = 不健康
# 端口优先取环境变量 PORT，其次读 /opt/invol/.env.local，最后默认 8080。

PORT="${PORT:-}"
if [ -z "$PORT" ] && [ -r /opt/invol/.env.local ]; then
    PORT="$(sed -n 's/^PORT=//p' /opt/invol/.env.local | tail -n 1 | tr -d '"[:space:]')"
fi
case "$PORT" in
    ''|*[!0-9]*) PORT=8080 ;;
esac

RESPONSE=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/health" || echo "000")

if [ "$RESPONSE" = "200" ]; then
    echo "✅ Fastify 健康 (HTTP $RESPONSE，端口 $PORT)"
    exit 0
else
    echo "❌ Fastify 不健康 (HTTP $RESPONSE，端口 $PORT)"
    exit 1
fi
