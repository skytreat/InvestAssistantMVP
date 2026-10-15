#!/usr/bin/env bash
set -euo pipefail

# InvestAssistant MVP 部署脚本（OCI ARM 2C12G）
# 用法：bash deploy/deploy.sh [--skip-build]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="/opt/invol"
USERNAME="invol"

echo "=== InvestAssistant MVP 部署 ==="

# Step 1: 创建 invol 用户和目录
if ! id "$USERNAME" &>/dev/null; then
    useradd -r -s /bin/false "$USERNAME"
    echo "✅ 创建用户 $USERNAME"
fi

mkdir -p "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/backup"
mkdir -p "$DEPLOY_DIR/secrets"
mkdir -p "$DEPLOY_DIR/plugins/strategies"
mkdir -p "$DEPLOY_DIR/frontend/dist"
echo "✅ 目录结构就绪"

# Step 2: 安装 Node.js 22
if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    echo "✅ Node.js $(node -v) 安装完成"
fi

# Step 3: 安装 tdx2db 预编译二进制
if [ ! -f /usr/local/bin/tdx2db ]; then
    cd /tmp
    wget -q https://github.com/jing2uo/tdx2db/releases/download/v2026.8.12/tdx2db_Linux_arm64.tar.gz
    tar -xzf tdx2db_Linux_arm64.tar.gz
    mv tdx2db /usr/local/bin/
    chmod +x /usr/local/bin/tdx2db
    rm tdx2db_Linux_arm64.tar.gz
    echo "✅ tdx2db v2026.8.12 安装完成"
fi

# Step 4: 安装系统依赖
apt-get update -qq && apt-get install -y -qq sqlite3 curl wget
echo "✅ 系统依赖就绪"

# Step 5: npm install + build
cd "$PROJECT_ROOT"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
npm run build --workspace=apps/backend
npm run build --workspace=apps/frontend 2>/dev/null || true  # 前端 Phase 3 才有
echo "✅ 构建完成"

# Step 6: 复制产物
cp -r "$PROJECT_ROOT/apps/backend/dist" "$DEPLOY_DIR/"
cp -r "$PROJECT_ROOT/apps/frontend/dist" "$DEPLOY_DIR/frontend/" 2>/dev/null || true
cp "$PROJECT_ROOT/.env.local" "$DEPLOY_DIR/"
echo "✅ 产物部署完成"

# Step 7: 设置权限
chown -R "$USERNAME:$USERNAME" "$DEPLOY_DIR"
echo "✅ 权限设置完成"

# Step 8: 安装 systemd units
cp "$SCRIPT_DIR/tdx2db.service" /etc/systemd/system/
cp "$SCRIPT_DIR/tdx2db-update.timer" /etc/systemd/system/
cp "$SCRIPT_DIR/invest-assistant.service" /etc/systemd/system/
cp "$SCRIPT_DIR/Caddyfile" /etc/caddy/
systemctl daemon-reload
systemctl enable tdx2db-update.timer
systemctl enable invest-assistant.service
systemctl enable caddy
echo "✅ systemd units 安装完成"

# Step 9: 首次 tdx2db init（手动触发）
if [ ! -f "$DEPLOY_DIR/quotes.duckdb" ]; then
    echo "首次 tdx2db init...（需要下载 hsjday.zip，可能几分钟）"
    runuser -u "$USERNAME" -- tdx2db init --dburi "duckdb://$DEPLOY_DIR/quotes.duckdb" --dayfiledir /tmp/vipdoc
    runuser -u "$USERNAME" -- tdx2db cron --dburi "duckdb://$DEPLOY_DIR/quotes.duckdb"
    echo "✅ DuckDB 行情库初始化完成"
fi

# Step 10: 启动服务
systemctl start caddy
systemctl start invest-assistant.service
echo ""
echo "=== 部署完成 ==="
echo "Fastify: systemctl status invest-assistant"
echo "DuckDB 定时更新: systemctl status tdx2db-update.timer"
echo "Caddy: systemctl status caddy"
echo "日志: journalctl -u invest-assistant -f"
