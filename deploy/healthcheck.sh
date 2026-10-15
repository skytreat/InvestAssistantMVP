#!/usr/bin/env bash
set -euo pipefail

# Fastify 健康检查脚本
# 返回 0 = 健康，非 0 = 不健康

RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/api/health || echo "000")

if [ "$RESPONSE" = "200" ]; then
    echo "✅ Fastify 健康 (HTTP $RESPONSE)"
    exit 0
else
    echo "❌ Fastify 不健康 (HTTP $RESPONSE)"
    exit 1
fi
