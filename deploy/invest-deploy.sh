#!/usr/bin/env bash
set -Eeuo pipefail

# 服务端 CD 入口（由 SSH forced command 调用，见 deploy/install-cd-host.sh）。
#
# 只接受一个 40 位 commit SHA；所有 git / 构建 / 切换动作都在生产机本地完成。
# 成功时输出 `deployed <sha>` 或 `already deployed <sha>`，供 GitHub Actions 校验。
#
# 约束：
# - 必须 root 运行（SSH 侧通过 sudoers 精确授权到本脚本，参数为空）；
# - 同一时刻只允许一个部署（flock）；
# - 工作日 16:55-17:45（Asia/Shanghai）与 tdx2db 写窗口内拒绝部署；
# - SHA 必须已合入 origin/main，且通过 CI 门禁（门禁在 GitHub Actions 侧）。
#
# 手工调试（root）：
#   sudo bash deploy/invest-deploy.sh <40位sha>

REPO_DIR="${IA_REPO_DIR:-/opt/invol/InvestAssistantMVP}"
DEPLOY_DIR="${IA_DEPLOY_DIR:-/opt/invol/IA_Prod}"
MARKER="$DEPLOY_DIR/.deployed-sha"
SENTINEL="$DEPLOY_DIR/.tdx2db-writing"
LOCK_FILE="/run/invest-deploy.lock"
LOG_DIR="/var/log/invest-deploy"

SHA="${SSH_ORIGINAL_COMMAND:-${1:-}}"

if [ "$(id -u)" -ne 0 ]; then
    echo "must run as root" >&2
    exit 1
fi

if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: ssh <host> '<40-hex commit sha>'" >&2
    exit 2
fi

# 让部署脱离 SSH 会话：连接断开时 sshd 的 SIGHUP 不会杀掉切换中的部署。
# 子进程写日志，结束后由父进程回传；断线后部署继续，下一次 CD 靠 marker 幂等。
if [ "${IA_INVEST_DEPLOY_DETACHED:-0}" != "1" ]; then
    if ! command -v setsid >/dev/null 2>&1; then
        echo "warn: setsid 不可用，部署无法与 SSH 会话解耦" >&2
    else
        install -d -m 0750 "$LOG_DIR"
        LOG_FILE="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}.log"
        export IA_INVEST_DEPLOY_DETACHED=1
        nohup setsid -w bash "$0" "$SHA" >"$LOG_FILE" 2>&1 &
        CHILD_PID=$!
        RC=0
        wait "$CHILD_PID" || RC=$?
        # 部署结束后一次性回传完整日志；断线时父进程死亡，子进程继续。
        cat "$LOG_FILE"
        echo "deploy log: $LOG_FILE" >&2
        exit "$RC"
    fi
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "another deploy is running" >&2
    exit 3
fi

# 行情链路避让：17:00 tdx2db 最长跑 30 分钟，17:01-17:05 的 Fastify 进程内 cron
# 在重启后会丢失当段任务，故窗口内一律不部署。
hhmm="$(TZ=Asia/Shanghai date +%H%M)"
dow="$(TZ=Asia/Shanghai date +%u)"
hhmm=$((10#$hhmm))
if [ "$dow" -le 5 ] && [ "$hhmm" -ge 1655 ] && [ "$hhmm" -le 1745 ]; then
    echo "inside market-data window (16:55-17:45 Asia/Shanghai), skip" >&2
    exit 4
fi
if [ -e "$SENTINEL" ]; then
    echo "tdx2db write window in progress, skip" >&2
    exit 4
fi

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "not a git repository: $REPO_DIR" >&2
    exit 5
fi
for required in "$REPO_DIR/deploy/deploy.sh" "$REPO_DIR/deploy/healthcheck.sh"; do
    if [ ! -f "$required" ]; then
        echo "missing deploy asset: $required" >&2
        exit 5
    fi
done

DEPLOYED="$(cat "$MARKER" 2>/dev/null || true)"
if [ "$DEPLOYED" = "$SHA" ]; then
    echo "already deployed $SHA"
    exit 0
fi

# 仓库可能属于 invol/ubuntu 等非 root 用户；git 操作以属主身份执行，
# 避免 root 在 .git 里留下混合属主。
REPO_OWNER="$(stat -c '%U' "$REPO_DIR")"
if [ "$REPO_OWNER" != "root" ]; then
    if ! id -u "$REPO_OWNER" >/dev/null 2>&1; then
        echo "repository owner is not a valid user: $REPO_OWNER" >&2
        exit 5
    fi
    # runuser 直接以该 uid 执行命令，不要求登录 shell；实测一次比猜 shell 更可靠。
    if ! runuser -u "$REPO_OWNER" -- true; then
        echo "cannot run commands as repository owner: $REPO_OWNER" >&2
        exit 5
    fi
    if ! runuser -u "$REPO_OWNER" -- test -w "$REPO_DIR/.git"; then
        echo "repository owner $REPO_OWNER cannot write $REPO_DIR/.git" >&2
        exit 5
    fi
fi
GIT_BIN="$(command -v git)"
run_as_owner() {
    if [ "$REPO_OWNER" = "root" ]; then
        "$@"
    else
        runuser -u "$REPO_OWNER" -- "$@"
    fi
}

echo "fetching origin/main..."
run_as_owner "$GIT_BIN" -C "$REPO_DIR" -c safe.directory="$REPO_DIR" fetch --prune origin main

if ! run_as_owner "$GIT_BIN" -C "$REPO_DIR" cat-file -e "${SHA}^{commit}" 2>/dev/null; then
    echo "commit not found: $SHA" >&2
    exit 5
fi
if ! run_as_owner "$GIT_BIN" -C "$REPO_DIR" merge-base --is-ancestor "$SHA" origin/main; then
    echo "commit is not on origin/main: $SHA" >&2
    exit 5
fi

echo "deploying $SHA..."
run_as_owner "$GIT_BIN" -C "$REPO_DIR" -c safe.directory="$REPO_DIR" reset --hard "$SHA"

# deploy.sh 内含构建、原子切换、健康检查与 app.old 自动回滚；失败即非 0 退出。
# 本进程已持有 /run/invest-deploy.lock，用环境变量让 deploy.sh 跳过重复加锁。
IA_DEPLOY_LOCK_HELD=1 bash "$REPO_DIR/deploy/deploy.sh"
bash "$REPO_DIR/deploy/healthcheck.sh"

MARKED="$(cat "$MARKER" 2>/dev/null || true)"
if [ "$MARKED" != "$SHA" ]; then
    echo "deploy finished but marker is '${MARKED:-<missing>}' (expected $SHA)" >&2
    exit 6
fi

echo "deployed $SHA"
