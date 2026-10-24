#!/usr/bin/env bash
set -Eeuo pipefail

# InvestAssistant MVP 生产部署脚本（OCI Ubuntu 24.04，ARM/x86）
#
# 用法：
#   sudo bash deploy/deploy.sh
#   sudo bash deploy/deploy.sh --skip-build
#   sudo CADDY_DOMAIN=invest.example.com CADDY_EMAIL=admin@example.com \
#     bash deploy/deploy.sh
#
# 说明：
# - 生产环境配置只从 /opt/invol/IA_Prod/.env.local 读取；不会用仓库里的 .env.local 覆盖。
# - 后端运行目录为 /opt/invol/IA_Prod/app，包含 dist + prod node_modules + packages/core。
# - 前端静态产物原子切换到 /opt/invol/IA_Prod/frontend/dist。
# - Caddy 是可选前置依赖；未安装或未提供域名时跳过 HTTPS，不中断部署。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LEGACY_DIR="/opt/invol"
DEPLOY_DIR="$LEGACY_DIR/IA_Prod"
APP_DIR="$DEPLOY_DIR/app"
APP_STAGE="$DEPLOY_DIR/.app.new"
FRONTEND_DIR="$DEPLOY_DIR/frontend/dist"
FRONTEND_STAGE="$DEPLOY_DIR/frontend/.dist.new"
ENV_FILE="$DEPLOY_DIR/.env.local"
USERNAME="invol"
TDX2DB_BIN="/usr/local/bin/tdx2db"
TDX2DB_VERSION="${TDX2DB_VERSION:-v2026.8.12}"

SKIP_BUILD=0
CURRENT_STEP="初始化"
APP_PORT=8080
CADDY_CONFIGURED=0
TEMP_DIR=""

usage() {
    cat <<'EOF'
InvestAssistant MVP 生产部署脚本（OCI Ubuntu 24.04，ARM/x86）

用法：
  sudo bash deploy/deploy.sh
  sudo bash deploy/deploy.sh --skip-build
  sudo CADDY_DOMAIN=invest.example.com CADDY_EMAIL=admin@example.com \
    bash deploy/deploy.sh

说明：
- 生产环境配置只从 /opt/invol/IA_Prod/.env.local 读取；不会用仓库里的 .env.local 覆盖。
- 后端运行目录为 /opt/invol/IA_Prod/app，包含 dist + prod node_modules + packages/core。
- 前端静态产物原子切换到 /opt/invol/IA_Prod/frontend/dist。
- Caddy 是可选前置依赖；未安装或未提供域名时跳过 HTTPS，不中断部署。
EOF
}

cleanup() {
    if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
}
trap cleanup EXIT
trap 'echo "❌ 部署失败：${CURRENT_STEP}（行 ${LINENO}）" >&2' ERR

while [ "$#" -gt 0 ]; do
    case "$1" in
        --skip-build)
            SKIP_BUILD=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "未知参数：$1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ 请使用 root 运行：sudo bash deploy/deploy.sh" >&2
    exit 1
fi

if [ ! -f "$PROJECT_ROOT/package.json" ]; then
    echo "❌ 未找到项目根目录：$PROJECT_ROOT" >&2
    exit 1
fi

echo "=== InvestAssistant MVP 生产部署 ==="
echo "项目目录：$PROJECT_ROOT"
echo "部署目录：$DEPLOY_DIR"
echo "运行用户：$USERNAME"

# ---------------------------------------------------------------------------
# 1. 系统依赖 / Node / tdx2db
# ---------------------------------------------------------------------------
CURRENT_STEP="安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl wget gnupg sqlite3
echo "✅ 系统依赖就绪"

CURRENT_STEP="检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 未安装，安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "❌ Node.js 版本过低：$(node -v)，要求 >=22" >&2
    exit 1
fi
if [ "$NODE_MAJOR" -gt 22 ]; then
    echo "⚠️  当前 Node.js $(node -v) 高于 22；项目要求 >=22，继续使用，不自动降级"
fi
echo "✅ Node.js $(node -v)"

CURRENT_STEP="检查 tdx2db"
if [ -x "$TDX2DB_BIN" ]; then
    echo "tdx2db 已存在：$TDX2DB_BIN"
    "$TDX2DB_BIN" --version 2>/dev/null || true
    echo "ℹ️  升级 tdx2db 需手动替换 $TDX2DB_BIN（本脚本不自动覆盖）"
else
    case "$(uname -m)" in
        aarch64|arm64) TDX2DB_ARCH="arm64" ;;
        x86_64|amd64) TDX2DB_ARCH="x86_64" ;;
        *)
            echo "❌ 不支持的 CPU 架构：$(uname -m)" >&2
            exit 1
            ;;
    esac

    case "$TDX2DB_VERSION" in
        v*) ;;
        *) TDX2DB_VERSION="v$TDX2DB_VERSION" ;;
    esac

    TDX2DB_URL="https://github.com/jing2uo/tdx2db/releases/download/${TDX2DB_VERSION}/tdx2db_Linux_${TDX2DB_ARCH}.tar.gz"
    TEMP_DIR="$(mktemp -d)"
    echo "下载 tdx2db ${TDX2DB_VERSION} (${TDX2DB_ARCH})..."
    wget -q -O "$TEMP_DIR/tdx2db.tar.gz" "$TDX2DB_URL"

    if [ -n "${TDX2DB_SHA256:-}" ]; then
        echo "${TDX2DB_SHA256}  $TEMP_DIR/tdx2db.tar.gz" | sha256sum -c -
    fi

    tar -xzf "$TEMP_DIR/tdx2db.tar.gz" -C "$TEMP_DIR"
    TDX2DB_EXTRACTED="$(find "$TEMP_DIR" -type f -name tdx2db -print -quit)"
    if [ -z "$TDX2DB_EXTRACTED" ]; then
        echo "❌ tdx2db 压缩包中未找到二进制" >&2
        exit 1
    fi
    install -m 755 "$TDX2DB_EXTRACTED" "$TDX2DB_BIN"
    echo "✅ tdx2db ${TDX2DB_VERSION} 安装完成"
fi

# ---------------------------------------------------------------------------
# 2. 用户与目录
# ---------------------------------------------------------------------------
CURRENT_STEP="创建运行用户和目录"
if ! id "$USERNAME" >/dev/null 2>&1; then
    useradd -r -s /bin/false "$USERNAME"
    echo "✅ 创建用户 $USERNAME"
fi

mkdir -p "$LEGACY_DIR"
install -d -m 755 "$DEPLOY_DIR"
install -d -m 750 "$DEPLOY_DIR/data" "$DEPLOY_DIR/backup" "$DEPLOY_DIR/plugins/strategies"
install -d -m 700 "$DEPLOY_DIR/secrets"
install -d -m 755 "$DEPLOY_DIR/frontend"

chown "$USERNAME:$USERNAME" "$DEPLOY_DIR"
chown -R "$USERNAME:$USERNAME" \
    "$DEPLOY_DIR/data" \
    "$DEPLOY_DIR/backup" \
    "$DEPLOY_DIR/plugins" \
    "$DEPLOY_DIR/secrets"
chmod 750 "$DEPLOY_DIR/data" "$DEPLOY_DIR/backup" "$DEPLOY_DIR/plugins" "$DEPLOY_DIR/plugins/strategies"
chmod 700 "$DEPLOY_DIR/secrets"
echo "✅ 目录结构就绪"

# ---------------------------------------------------------------------------
# 3. 生产环境文件（绝不从仓库复制 .env.local）
# ---------------------------------------------------------------------------
CURRENT_STEP="检查生产环境文件"
if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$LEGACY_DIR/.env.local" ]; then
        install -m 600 "$LEGACY_DIR/.env.local" "$ENV_FILE"
        chown "$USERNAME:$USERNAME" "$ENV_FILE"
        sed -i \
            -e "s|^SQLITE_DB_PATH=$LEGACY_DIR/business.db$|SQLITE_DB_PATH=$DEPLOY_DIR/data/business.db|" \
            -e "s|^SQLITE_DB_PATH=$LEGACY_DIR/|SQLITE_DB_PATH=$DEPLOY_DIR/|" \
            -e "s|^DUCKDB_PATH=$LEGACY_DIR/|DUCKDB_PATH=$DEPLOY_DIR/|" \
            -e "s|^BACKUP_DIR=$LEGACY_DIR/|BACKUP_DIR=$DEPLOY_DIR/|" \
            -e "s|^PLUGIN_ALLOWED_PATH=$LEGACY_DIR/|PLUGIN_ALLOWED_PATH=$DEPLOY_DIR/|" \
            -e "s|^TDX2DB_WRITE_SENTINEL=$LEGACY_DIR/|TDX2DB_WRITE_SENTINEL=$DEPLOY_DIR/|" \
            "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo "⚠️  已从 $LEGACY_DIR/.env.local 复制生产配置到 $ENV_FILE，并改写路径。" >&2
        echo "   请核对 JWT_SECRET / TUSHARE_TOKEN / SQLITE_DB_PATH / DUCKDB_PATH / BACKUP_DIR 后重新执行本脚本。" >&2
        exit 1
    fi
    if [ -f "$PROJECT_ROOT/.env.template" ]; then
        install -m 600 "$PROJECT_ROOT/.env.template" "$ENV_FILE"
        chown "$USERNAME:$USERNAME" "$ENV_FILE"
        echo "⚠️  已生成 $ENV_FILE 模板。" >&2
        echo "   请填写 JWT_SECRET / TUSHARE_TOKEN 等生产配置后，重新执行本脚本。" >&2
        exit 1
    fi
    echo "❌ 缺少 $ENV_FILE，且找不到 .env.template" >&2
    exit 1
fi

chown "$USERNAME:$USERNAME" "$ENV_FILE"
chmod 600 "$ENV_FILE"

if ! grep -Eq '^JWT_SECRET=.+' "$ENV_FILE"; then
    echo "❌ $ENV_FILE 缺少 JWT_SECRET" >&2
    exit 1
fi
if grep -Eq '^JWT_SECRET=(change-me|replace_with|your_)' "$ENV_FILE"; then
    echo "❌ $ENV_FILE 的 JWT_SECRET 仍是占位值，请替换" >&2
    exit 1
fi
if ! grep -Eq '^TUSHARE_TOKEN=.+' "$ENV_FILE"; then
    echo "⚠️  $ENV_FILE 未配置 TUSHARE_TOKEN；C11/C12 将无法调用 Tushare" >&2
elif grep -q '^TUSHARE_TOKEN=your_tushare_token_here' "$ENV_FILE"; then
    echo "⚠️  $ENV_FILE 的 TUSHARE_TOKEN 仍是占位值" >&2
fi

APP_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d '"[:space:]')"
case "$APP_PORT" in
    ''|*[!0-9]*) APP_PORT=8080 ;;
esac
echo "✅ 生产环境文件就绪（HTTP 端口 $APP_PORT）"

# 新目录首次部署时，绝不自动创建空库覆盖旧数据；必须先按文档迁移。
CURRENT_STEP="检查旧部署数据"
if [ ! -e "$DEPLOY_DIR/data/business.db" ]; then
    for legacy_db in "$LEGACY_DIR/data/business.db" "$LEGACY_DIR/business.db"; do
        if [ -e "$legacy_db" ]; then
            echo "❌ 检测到旧 SQLite 业务库：$legacy_db" >&2
            echo "   新目录 $DEPLOY_DIR/data/business.db 尚不存在，脚本已停止，避免创建空库。" >&2
            echo "   请先按 docs/deploy.md「从旧目录迁移」停服迁移数据，再重新执行。" >&2
            exit 1
        fi
    done
fi
if [ ! -e "$DEPLOY_DIR/quotes.duckdb" ]; then
    for legacy_quotes in "$LEGACY_DIR/quotes.duckdb" "$LEGACY_DIR/data/quotes.duckdb"; do
        if [ -e "$legacy_quotes" ]; then
            echo "❌ 检测到旧 DuckDB 行情库：$legacy_quotes" >&2
            echo "   新目录 $DEPLOY_DIR/quotes.duckdb 尚不存在，脚本已停止，避免重新初始化空库。" >&2
            echo "   请先按 docs/deploy.md「从旧目录迁移」停服迁移数据，再重新执行。" >&2
            exit 1
        fi
    done
fi

# 兼容已有部署：旧库可能属于 ubuntu 或其他用户，启动前统一到专用账号。
CURRENT_STEP="规范已有 SQLite 文件权限"
SQLITE_DB_PATH_CFG="$(sed -n 's/^SQLITE_DB_PATH=//p' "$ENV_FILE" | tail -n 1 | tr -d '"[:space:]')"
DUCKDB_PATH_CFG="$(sed -n 's/^DUCKDB_PATH=//p' "$ENV_FILE" | tail -n 1 | tr -d '"[:space:]')"
BACKUP_DIR_CFG="$(sed -n 's/^BACKUP_DIR=//p' "$ENV_FILE" | tail -n 1 | tr -d '"[:space:]')"
for cfg in "SQLITE_DB_PATH:$SQLITE_DB_PATH_CFG" "DUCKDB_PATH:$DUCKDB_PATH_CFG" "BACKUP_DIR:$BACKUP_DIR_CFG"; do
    key="${cfg%%:*}"
    value="${cfg#*:}"
    case "$value" in
        "$DEPLOY_DIR"/*) ;;
        *)
            echo "❌ $key 必须位于 $DEPLOY_DIR 下（当前值：${value:-未设置}）" >&2
            echo "   请修正 $ENV_FILE 后重新执行，避免在旧路径下创建空库。" >&2
            exit 1
            ;;
    esac
done
for db in "$DEPLOY_DIR/data/business.db" "$DEPLOY_DIR/business.db" "$SQLITE_DB_PATH_CFG"; do
    [ -n "$db" ] || continue
    [ -f "$db" ] || continue
    chown "$USERNAME:$USERNAME" "$db"
    chmod 600 "$db"
    for suffix in -wal -shm; do
        if [ -f "$db$suffix" ]; then
            chown "$USERNAME:$USERNAME" "$db$suffix"
            chmod 600 "$db$suffix"
        fi
    done
done
echo "✅ SQLite 文件权限就绪"

# ---------------------------------------------------------------------------
# 4. 构建
# ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" -eq 1 ]; then
    CURRENT_STEP="校验已有构建产物"
    for path in \
        "$PROJECT_ROOT/apps/backend/dist/server.js" \
        "$PROJECT_ROOT/packages/core/dist/esm/index.js" \
        "$PROJECT_ROOT/packages/core/dist/cjs/index.cjs" \
        "$PROJECT_ROOT/apps/frontend/dist/index.html"; do
        if [ ! -e "$path" ]; then
            echo "❌ --skip-build 但缺少构建产物：$path" >&2
            exit 1
        fi
    done
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        echo "❌ --skip-build 但 node_modules 不存在" >&2
        exit 1
    fi
    echo "✅ 复用已有构建产物"
else
    CURRENT_STEP="构建 core / backend / frontend"
    cd "$PROJECT_ROOT"
    npm ci
    npm run build

    CURRENT_STEP="裁剪 devDependencies"
    npm prune --omit=dev --ignore-scripts

    for path in \
        "$PROJECT_ROOT/apps/backend/dist/server.js" \
        "$PROJECT_ROOT/packages/core/dist/esm/index.js" \
        "$PROJECT_ROOT/packages/core/dist/cjs/index.cjs" \
        "$PROJECT_ROOT/apps/frontend/dist/index.html"; do
        if [ ! -e "$path" ]; then
            echo "❌ 构建产物缺失：$path" >&2
            exit 1
        fi
    done
    echo "✅ 构建完成"
fi

# ---------------------------------------------------------------------------
# 5. 组装后端运行目录（必须带 prod node_modules 与 core dist）
# ---------------------------------------------------------------------------
CURRENT_STEP="组装后端运行目录"
rm -rf "$APP_STAGE"
install -d -m 755 "$APP_STAGE/dist" "$APP_STAGE/packages/core"
cp -a "$PROJECT_ROOT/apps/backend/dist/." "$APP_STAGE/dist/"
cp "$PROJECT_ROOT/apps/backend/package.json" "$APP_STAGE/package.json"
cp -a "$PROJECT_ROOT/packages/core/dist" "$APP_STAGE/packages/core/dist"
cp "$PROJECT_ROOT/packages/core/package.json" "$APP_STAGE/packages/core/package.json"
cp -a "$PROJECT_ROOT/node_modules" "$APP_STAGE/node_modules"

# 这两个 workspace 链接指向源码目录，生产运行目录不需要；@invest/core 必须保留。
rm -f "$APP_STAGE/node_modules/@invest/backend" "$APP_STAGE/node_modules/@invest/frontend"
ln -sfn ../../packages/core "$APP_STAGE/node_modules/@invest/core"

# 在切换前验证所有生产依赖能在目标布局中加载（含 native 模块）。
(
    cd "$APP_STAGE"
    node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
(async () => {
  for (const name of Object.keys(pkg.dependencies || {})) {
    await import(name);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
)

chown -R root:root "$APP_STAGE"
chmod -R a+rX "$APP_STAGE"
echo "✅ 后端运行目录校验通过"

# ---------------------------------------------------------------------------
# 6. 前端产物 staging（后端健康检查通过后再切换）
# ---------------------------------------------------------------------------
CURRENT_STEP="准备前端静态产物"
rm -rf "$FRONTEND_STAGE"
install -d -m 755 "$FRONTEND_STAGE"
cp -a "$PROJECT_ROOT/apps/frontend/dist/." "$FRONTEND_STAGE/"
chmod -R a+rX "$FRONTEND_STAGE"
echo "✅ 前端静态产物已就绪"

# ---------------------------------------------------------------------------
# 7. systemd units
# ---------------------------------------------------------------------------
CURRENT_STEP="安装 systemd units"
install -m 644 "$SCRIPT_DIR/tdx2db.service" /etc/systemd/system/tdx2db.service
install -m 644 "$SCRIPT_DIR/tdx2db-update.timer" /etc/systemd/system/tdx2db-update.timer
install -m 644 "$SCRIPT_DIR/invest-assistant.service" /etc/systemd/system/invest-assistant.service
systemctl daemon-reload
systemctl disable tdx2db.service >/dev/null 2>&1 || true
# 允许 Fastify 运行用户（invol）无交互管理 tdx2db.service，供 rerun 降级链使用
if [ -d /etc/polkit-1/rules.d ]; then
    cat > /etc/polkit-1/rules.d/50-invest-tdx2db.rules <<'POLKIT'
polkit.addRule(function(action, subject) {
    if (action.id === "org.freedesktop.systemd1.manage-units" &&
        subject.user === "invol" &&
        action.lookup("unit") === "tdx2db.service") {
        return polkit.Result.YES;
    }
});
POLKIT
    systemctl restart polkit >/dev/null 2>&1 || true
fi
systemctl enable tdx2db-update.timer
systemctl enable --now tdx2db-update.timer
systemctl restart tdx2db-update.timer
echo "✅ systemd units 安装完成"

# ---------------------------------------------------------------------------
# 8. 首次初始化行情库
# ---------------------------------------------------------------------------
CURRENT_STEP="初始化 DuckDB 行情库"
if [ ! -f "$DEPLOY_DIR/quotes.duckdb" ]; then
    echo "首次 tdx2db init...（需要下载 hsjday.zip，可能几分钟）"
    (
        umask 077
        runuser -u "$USERNAME" -- "$TDX2DB_BIN" init \
            --dburi "duckdb://$DEPLOY_DIR/quotes.duckdb" \
            --dayfiledir /tmp/vipdoc
        runuser -u "$USERNAME" -- "$TDX2DB_BIN" cron \
            --dburi "duckdb://$DEPLOY_DIR/quotes.duckdb"
    )
    echo "✅ DuckDB 行情库初始化完成"
fi

if [ -f "$DEPLOY_DIR/quotes.duckdb" ]; then
    chown "$USERNAME:$USERNAME" "$DEPLOY_DIR/quotes.duckdb"
    chmod 600 "$DEPLOY_DIR/quotes.duckdb"
fi

# ---------------------------------------------------------------------------
# 9. 原子切换后端并启动
# ---------------------------------------------------------------------------
CURRENT_STEP="切换后端运行目录"
systemctl stop invest-assistant.service >/dev/null 2>&1 || true
rm -rf "$APP_DIR.old"
if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "$APP_DIR.old"
fi
mv "$APP_STAGE" "$APP_DIR"

rollback_app() {
    echo "↩️  回滚后端到上一版本..." >&2
    systemctl stop invest-assistant.service >/dev/null 2>&1 || true
    rm -rf "$APP_DIR"
    if [ -d "$APP_DIR.old" ]; then
        mv "$APP_DIR.old" "$APP_DIR"
    fi
    systemctl start invest-assistant.service >/dev/null 2>&1 || true
}

CURRENT_STEP="启动 Fastify"
systemctl enable invest-assistant.service
if ! systemctl restart invest-assistant.service; then
    rollback_app
    exit 1
fi

CURRENT_STEP="健康检查"
HEALTHY=0
for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
        HEALTHY=1
        break
    fi
    sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
    echo "❌ Fastify 健康检查失败（http://127.0.0.1:${APP_PORT}/api/health）" >&2
    journalctl -u invest-assistant.service -n 50 --no-pager >&2 || true
    rollback_app
    exit 1
fi
echo "✅ Fastify 健康检查通过"

# ---------------------------------------------------------------------------
# 10. 前端产物切换（后端健康后）
# ---------------------------------------------------------------------------
CURRENT_STEP="切换前端静态产物"
rm -rf "$DEPLOY_DIR/frontend/dist.old"
if [ -d "$FRONTEND_DIR" ]; then
    mv "$FRONTEND_DIR" "$DEPLOY_DIR/frontend/dist.old"
fi
mv "$FRONTEND_STAGE" "$FRONTEND_DIR"
echo "✅ 前端静态产物已切换"

# ---------------------------------------------------------------------------
# 11. Caddy（可选）
# ---------------------------------------------------------------------------
CURRENT_STEP="配置 Caddy"
if ! command -v caddy >/dev/null 2>&1; then
    echo "⚠️  Caddy 未安装，跳过 HTTPS 配置；API 仍只监听 127.0.0.1:${APP_PORT}"
elif [ -z "${CADDY_DOMAIN:-}" ] || [ -z "${CADDY_EMAIL:-}" ]; then
    echo "⚠️  未提供 CADDY_DOMAIN / CADDY_EMAIL，跳过 Caddy 配置"
    echo "   示例：sudo CADDY_DOMAIN=invest.example.com CADDY_EMAIL=admin@example.com bash deploy/deploy.sh"
else
    case "$CADDY_DOMAIN" in
        *[!A-Za-z0-9.-]*)
            echo "❌ CADDY_DOMAIN 格式非法：$CADDY_DOMAIN" >&2
            exit 1
            ;;
    esac
    case "$CADDY_EMAIL" in
        *[!A-Za-z0-9.@_+-]*)
            echo "❌ CADDY_EMAIL 格式非法：$CADDY_EMAIL" >&2
            exit 1
            ;;
    esac

    install -d -m 755 /etc/caddy
    sed \
        -e "s|__CADDY_DOMAIN__|$CADDY_DOMAIN|g" \
        -e "s|__CADDY_EMAIL__|$CADDY_EMAIL|g" \
        "$SCRIPT_DIR/Caddyfile" > /etc/caddy/Caddyfile.new
    if ! caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile; then
        rm -f /etc/caddy/Caddyfile.new
        echo "❌ Caddyfile 校验失败" >&2
        exit 1
    fi
    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
    systemctl enable caddy
    systemctl restart caddy
    CADDY_CONFIGURED=1
    echo "✅ Caddy 已配置并重启"
fi

echo ""
echo "=== 部署完成 ==="
echo "Fastify: systemctl status invest-assistant"
echo "DuckDB 定时更新: systemctl status tdx2db-update.timer"
if [ "$CADDY_CONFIGURED" -eq 1 ]; then
    echo "Caddy: systemctl status caddy"
else
    echo "Caddy: 未配置（见上方提示）"
fi
echo "日志: journalctl -u invest-assistant -f"
