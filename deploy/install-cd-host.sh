#!/usr/bin/env bash
set -Eeuo pipefail

# 一次性配置 CD 接收端（在生产机以 root 运行）。
#
# 完成：
# 1. 创建 deployer 用户（锁定密码、仅允许密钥登录）；
# 2. 安装 /usr/local/sbin/invest-deploy（root 所有，来自本仓库 deploy/invest-deploy.sh）；
# 3. 写入 sudoers：只允许 deployer 以 root 运行该 wrapper，且保留 SSH_ORIGINAL_COMMAND；
# 4. 写入 deployer 的 authorized_keys：restrict + forced command。
#
# 用法：
#   sudo bash deploy/install-cd-host.sh --public-key-file /tmp/cd-invest.pub
#
# 生成密钥（在可信机器上）：
#   ssh-keygen -t ed25519 -C "cd-invest" -f cd-invest -N ""
#   # 公钥安装到本机；私钥内容填入 GitHub environment secret DEPLOY_SSH_KEY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_SRC="$SCRIPT_DIR/invest-deploy.sh"
WRAPPER_DST="/usr/local/sbin/invest-deploy"
SUDOERS_FILE="/etc/sudoers.d/invest-deploy"
DEPLOY_USER="deployer"
REPO_DIR="/opt/invol/InvestAssistantMVP"
PUBKEY_FILE=""
FORCE=0

usage() {
    cat <<'EOF'
用法：
  sudo bash deploy/install-cd-host.sh --public-key-file <path> [--user deployer] [--force]

选项：
  --public-key-file <path>  CD 专用 SSH 公钥文件（必填，仅取第一行）
  --user <name>             运行部署的专用用户（默认 deployer）
  --force                   覆盖该用户已有的 authorized_keys
  -h, --help                显示本帮助

前置条件：
  - 仓库已克隆到 /opt/invol/InvestAssistantMVP
  - /opt/invol/IA_Prod/.env.local 已按 docs/deploy.md 配置
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --public-key-file)
            PUBKEY_FILE="${2:-}"
            shift 2
            ;;
        --user)
            DEPLOY_USER="${2:-}"
            shift 2
            ;;
        --force)
            FORCE=1
            shift
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
done

if [ "$(id -u)" -ne 0 ]; then
    echo "请使用 root 运行：sudo bash deploy/install-cd-host.sh ..." >&2
    exit 1
fi

case "$DEPLOY_USER" in
    ''|root|*[!a-z0-9_-]*)
        echo "非法的 deployer 用户名：$DEPLOY_USER" >&2
        exit 1
        ;;
esac

if [ -z "$PUBKEY_FILE" ] || [ ! -f "$PUBKEY_FILE" ]; then
    echo "缺少 --public-key-file（文件不存在：${PUBKEY_FILE:-未提供}）" >&2
    usage >&2
    exit 1
fi

if [ ! -f "$WRAPPER_SRC" ]; then
    echo "缺少 wrapper 源文件：$WRAPPER_SRC" >&2
    exit 1
fi

PUBKEY="$(head -n 1 "$PUBKEY_FILE" | tr -d '\r')"
case "$PUBKEY" in
    ssh-ed25519\ *|ecdsa-sha2-nistp256\ *|ecdsa-sha2-nistp384\ *|ecdsa-sha2-nistp521\ *|ssh-rsa\ *) ;;
    *)
        echo "公钥格式无法识别（需以 ssh-ed25519 / ecdsa-sha2-* / ssh-rsa 开头）" >&2
        exit 1
        ;;
esac
if [ "$(printf '%s\n' "$PUBKEY" | wc -l)" -ne 1 ]; then
    echo "公钥文件应只包含一行" >&2
    exit 1
fi

if [ -d "$REPO_DIR/.git" ]; then
    echo "仓库：$REPO_DIR（属主 $(stat -c '%U' "$REPO_DIR")）"
else
    echo "⚠️  未发现 $REPO_DIR/.git；请先克隆仓库并完成首次部署，再执行本脚本" >&2
fi

# ---------------------------------------------------------------------------
# 1. 专用用户
# ---------------------------------------------------------------------------
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd -r -m -d "/home/$DEPLOY_USER" -s /bin/bash "$DEPLOY_USER"
    echo "✅ 创建用户 $DEPLOY_USER"
else
    usermod -s /bin/bash "$DEPLOY_USER"
    echo "ℹ️  用户 $DEPLOY_USER 已存在"
fi
passwd -l "$DEPLOY_USER" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 2. wrapper（root 所有，deployer 不可写）
# ---------------------------------------------------------------------------
install -m 0755 -o root -g root "$WRAPPER_SRC" "$WRAPPER_DST"
echo "✅ 安装 $WRAPPER_DST"

# ---------------------------------------------------------------------------
# 3. sudoers：唯一允许的命令 + 保留 SSH_ORIGINAL_COMMAND
#
# sudo 默认 env_reset 会丢掉 sshd 注入的 SSH_ORIGINAL_COMMAND，
# 若不 env_keep，wrapper 收不到目标 SHA。
# ---------------------------------------------------------------------------
SUDOERS_TMP="$(mktemp)"
cat >"$SUDOERS_TMP" <<EOF
Defaults:$DEPLOY_USER env_keep += "SSH_ORIGINAL_COMMAND"
$DEPLOY_USER ALL=(root) NOPASSWD: $WRAPPER_DST ""
EOF
if ! visudo -cf "$SUDOERS_TMP" >/dev/null; then
    rm -f "$SUDOERS_TMP"
    echo "sudoers 校验失败" >&2
    exit 1
fi
install -m 0440 -o root -g root "$SUDOERS_TMP" "$SUDOERS_FILE"
rm -f "$SUDOERS_TMP"
echo "✅ 写入 $SUDOERS_FILE"

# ---------------------------------------------------------------------------
# 4. authorized_keys：restrict（禁 pty/转发/agent）+ forced command
# ---------------------------------------------------------------------------
HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
if [ -z "$HOME_DIR" ]; then
    HOME_DIR="/home/$DEPLOY_USER"
fi
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
AUTHORIZED_KEYS="$HOME_DIR/.ssh/authorized_keys"

if [ -s "$AUTHORIZED_KEYS" ] && ! grep -q "invest-deploy" "$AUTHORIZED_KEYS" && [ "$FORCE" -ne 1 ]; then
    echo "$AUTHORIZED_KEYS 已存在其他密钥；确认可覆盖后加 --force" >&2
    exit 1
fi

cat >"$AUTHORIZED_KEYS" <<EOF
# Managed by InvestAssistantMVP deploy/install-cd-host.sh
restrict,command="sudo -n $WRAPPER_DST" $PUBKEY
EOF
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTHORIZED_KEYS"
chmod 0600 "$AUTHORIZED_KEYS"
echo "✅ 写入 $AUTHORIZED_KEYS"

echo ""
echo "=== CD 接收端配置完成 ==="
echo "下一步（GitHub：Settings -> Environments -> production）："
echo "  secrets.DEPLOY_SSH_KEY    = 私钥文件全文"
echo "  secrets.DEPLOY_KNOWN_HOSTS= ssh-keyscan -t ed25519 <host> 的输出"
echo "  variables.DEPLOY_HOST     = 生产机地址"
echo "  variables.DEPLOY_USER     = $DEPLOY_USER"
echo ""
echo "验证：Actions -> CD Production -> Run workflow（填一个 main 上 CI 已绿的完整 SHA）"
