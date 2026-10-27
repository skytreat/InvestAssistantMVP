#!/usr/bin/env bash
# ============================================================
# 僵尸账号清理：只保留指定 admin，物理删除其他账号及其业务数据
#
# 默认 dry-run，不修改任何数据；确认后加 --apply 执行。
#
# 用法：
#   sudo bash deploy/purge-zombie-users.sh
#   sudo bash deploy/purge-zombie-users.sh --apply
#   sudo bash deploy/purge-zombie-users.sh --keep admin --apply
#   bash deploy/purge-zombie-users.sh --db /tmp/business.db --no-service --apply
#
# 默认值：
#   DB       = SQLITE_DB_PATH -> /opt/invol/IA_Prod/.env.local -> /opt/invol/IA_Prod/data/business.db
#   service  = invest-assistant.service
#   backup   = BACKUP_DIR -> 与 DB 同目录
#
# 执行流程（--apply）：
#   1. 校验保留账号是 admin，且库中存在当前 V3 schema
#   2. 停止服务
#   3. sqlite3 .backup 生成备份 + integrity_check
#   4. 单事务删除僵尸账号的子表数据 + 账号
#   5. 事务内 foreign_key_check，失败则整体回滚
#   6. 可选 VACUUM
#   7. 恢复服务
#
# ⚠️ 这是物理删除，与 AGENTS.md「业务记录软删除」的日常规则不同；
#    仅用于清理测试/废弃账号。执行前必须有备份。
# ============================================================
set -Eeuo pipefail

APPLY=0
KEEP_USER="admin"
DB_PATH=""
ENV_FILE="/opt/invol/IA_Prod/.env.local"
ENV_FILE_EXPLICIT=0
SERVICE="invest-assistant.service"
BACKUP_DIR="${BACKUP_DIR:-}"
USE_SERVICE=1
DO_VACUUM=1
SERVICE_WAS_ACTIVE=0
SERVICE_STOPPED=0

usage() {
    cat <<'EOF'
僵尸账号清理脚本（默认 dry-run）

用法：
  sudo bash deploy/purge-zombie-users.sh [选项]

选项：
  --apply                执行删除（不加则只打印审计信息）
  --dry-run              显式 dry-run（默认）
  --keep <username>      保留的 admin 用户名（默认 admin）
  --db <path>            SQLite 业务库路径
  --env-file <path>      读取 SQLITE_DB_PATH / BACKUP_DIR 的环境文件
                         默认 /opt/invol/IA_Prod/.env.local
  --backup-dir <path>    备份目录（默认 BACKUP_DIR 或 DB 同目录）
  --service <name>       systemd 服务名（默认 invest-assistant.service）
  --no-service           不停止/启动服务（DB 必须已无人占用）
  --no-vacuum            跳过 VACUUM
  -h, --help             显示本帮助

示例：
  sudo bash deploy/purge-zombie-users.sh
  sudo bash deploy/purge-zombie-users.sh --apply
  sudo bash deploy/purge-zombie-users.sh --keep admin --apply
EOF
}

log() {
    printf '%s\n' "$*"
}

die() {
    printf '[ERROR] %s\n' "$*" >&2
    exit 1
}

cleanup() {
    local rc=$?
    if [ "$SERVICE_STOPPED" -eq 1 ] && [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
        log "[INFO] 恢复服务：$SERVICE"
        systemctl start "$SERVICE" || log "[WARN] 服务启动失败，请手动检查：systemctl status $SERVICE"
    fi
    exit "$rc"
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
    case "$1" in
        --apply)
            APPLY=1
            ;;
        --dry-run)
            APPLY=0
            ;;
        --keep)
            [ "$#" -ge 2 ] || die "--keep 缺少参数"
            KEEP_USER="$2"
            shift
            ;;
        --db)
            [ "$#" -ge 2 ] || die "--db 缺少参数"
            DB_PATH="$2"
            shift
            ;;
        --env-file)
            [ "$#" -ge 2 ] || die "--env-file 缺少参数"
            ENV_FILE="$2"
            ENV_FILE_EXPLICIT=1
            shift
            ;;
        --backup-dir)
            [ "$#" -ge 2 ] || die "--backup-dir 缺少参数"
            BACKUP_DIR="$2"
            shift
            ;;
        --service)
            [ "$#" -ge 2 ] || die "--service 缺少参数"
            SERVICE="$2"
            shift
            ;;
        --no-service)
            USE_SERVICE=0
            ;;
        --no-vacuum)
            DO_VACUUM=0
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "未知参数：$1（使用 --help 查看用法）"
            ;;
    esac
    shift
done

[ -n "$KEEP_USER" ] || die "--keep 不能为空"
case "$KEEP_USER" in
    *$'\n'*|*$'\r'*)
        die "--keep 不能包含换行符"
        ;;
esac
[ "${#KEEP_USER}" -le 64 ] || die "--keep 过长"

if [ "$ENV_FILE_EXPLICIT" -eq 1 ]; then
    [ -f "$ENV_FILE" ] || die "--env-file 不存在：$ENV_FILE"
    [ -r "$ENV_FILE" ] || die "--env-file 不可读：$ENV_FILE"
fi

if [ -z "$DB_PATH" ]; then
    if [ -n "${SQLITE_DB_PATH:-}" ]; then
        DB_PATH="$SQLITE_DB_PATH"
    elif [ -r "$ENV_FILE" ]; then
        DB_PATH="$(sed -n 's/^SQLITE_DB_PATH=//p' "$ENV_FILE" | tail -n 1 | tr -d '"[:space:]')"
    fi
fi
[ -n "$DB_PATH" ] || DB_PATH="/opt/invol/IA_Prod/data/business.db"
[ -e "$DB_PATH" ] || die "数据库不存在：$DB_PATH"
DB_PATH="$(realpath -e "$DB_PATH")"
[ -f "$DB_PATH" ] || die "数据库不是普通文件：$DB_PATH"
[ -r "$DB_PATH" ] || die "数据库不可读：$DB_PATH"

command -v sqlite3 >/dev/null 2>&1 || die "缺少 sqlite3 命令"

if [ -z "$BACKUP_DIR" ] && [ -r "$ENV_FILE" ]; then
    BACKUP_DIR="$(sed -n 's/^BACKUP_DIR=//p' "$ENV_FILE" | tail -n 1 | tr -d '"[:space:]')"
fi
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="$(dirname "$DB_PATH")"

if [ "$APPLY" -eq 1 ]; then
    if [ "$USE_SERVICE" -eq 1 ]; then
        [ "$(id -u)" -eq 0 ] || die "停止/启动 systemd 服务需要 root；或加 --no-service"
        command -v systemctl >/dev/null 2>&1 || die "缺少 systemctl"
        case "$SERVICE" in
            *[!A-Za-z0-9_.@-]*|'')
                die "--service 名称非法：$SERVICE"
                ;;
        esac
    else
        [ -w "$DB_PATH" ] || die "数据库不可写：$DB_PATH"
        [ -w "$(dirname "$DB_PATH")" ] || die "数据库目录不可写，无法创建 WAL/临时文件：$(dirname "$DB_PATH")"
    fi
fi

for table in \
    user_account \
    user_trade_record \
    user_asset_rel \
    user_strategy_signal \
    user_fee_config \
    user_plugin_config \
    user_asset_stat \
    asset_class \
    broker_trade_record \
    broker_import_batch \
    broker_import_template; do
    exists="$(sqlite3 "$DB_PATH" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$table';")"
    [ "$exists" = "1" ] || die "缺少表 $table（不是当前 V3 schema？）"
done

sql_quote() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

KEEP_SQL="$(sql_quote "$KEEP_USER")"

ADMIN_COUNT="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM user_account WHERE username = $KEEP_SQL AND role = 'admin';")"
[ "$ADMIN_COUNT" = "1" ] || die "保留账号 $KEEP_USER 不存在或不是 admin（匹配数=$ADMIN_COUNT）"

TOTAL_USERS="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM user_account;")"
ZOMBIE_USERS="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM user_account WHERE username <> $KEEP_SQL;")"

log "数据库：$DB_PATH"
log "保留账号：$KEEP_USER（admin）"
log "账号总数：$TOTAL_USERS，待清理：$ZOMBIE_USERS"

if [ "$ZOMBIE_USERS" -eq 0 ]; then
    log "没有需要清理的账号。"
    exit 0
fi

log ""
log "=== 账号审计 ==="
sqlite3 -header -column "$DB_PATH" <<SQL
CREATE TEMP TABLE zombie AS
    SELECT id FROM user_account WHERE username <> $KEEP_SQL;

SELECT
    u.id,
    u.username,
    u.role,
    u.created_at,
    (SELECT COUNT(*) FROM user_trade_record   WHERE user_id = u.id AND is_deleted = 0) AS trades,
    (SELECT COUNT(*) FROM user_asset_rel      WHERE user_id = u.id AND is_deleted = 0) AS rels,
    (SELECT COUNT(*) FROM user_strategy_signal WHERE user_id = u.id AND is_deleted = 0) AS signals,
    (SELECT COUNT(*) FROM broker_trade_record WHERE user_id = u.id AND is_deleted = 0) AS broker_rows,
    (SELECT COUNT(*) FROM broker_import_batch WHERE user_id = u.id AND is_deleted = 0) AS batches,
    (SELECT COUNT(*) FROM broker_import_template WHERE user_id = u.id AND is_deleted = 0) AS templates,
    (SELECT COUNT(*) FROM user_fee_config     WHERE user_id = u.id AND is_deleted = 0) AS fee_cfgs,
    (SELECT COUNT(*) FROM user_plugin_config  WHERE user_id = u.id) AS plugin_cfgs,
    (SELECT COUNT(*) FROM user_asset_stat     WHERE user_id = u.id) AS stats
FROM user_account u
ORDER BY u.id;

SELECT '待删除账号' AS metric, COUNT(*) AS value FROM zombie
UNION ALL SELECT '待删除交易', COUNT(*) FROM user_trade_record WHERE user_id IN (SELECT id FROM zombie)
UNION ALL SELECT '待删除持仓/自选', COUNT(*) FROM user_asset_rel WHERE user_id IN (SELECT id FROM zombie)
UNION ALL SELECT '待删除信号', COUNT(*) FROM user_strategy_signal WHERE user_id IN (SELECT id FROM zombie)
UNION ALL SELECT '待删除券商事实行', COUNT(*) FROM broker_trade_record WHERE user_id IN (SELECT id FROM zombie)
UNION ALL SELECT '待删除导入批次', COUNT(*) FROM broker_import_batch WHERE user_id IN (SELECT id FROM zombie)
UNION ALL SELECT '待删除导入模板', COUNT(*) FROM broker_import_template WHERE user_id IN (SELECT id FROM zombie)
UNION ALL SELECT '待删除费用配置', COUNT(*) FROM user_fee_config WHERE user_id IN (SELECT id FROM zombie)
UNION ALL SELECT '待删除插件配置', COUNT(*) FROM user_plugin_config WHERE user_id IN (SELECT id FROM zombie)
UNION ALL SELECT '待删除资产快照', COUNT(*) FROM user_asset_stat WHERE user_id IN (SELECT id FROM zombie);
SQL

if [ "$APPLY" -ne 1 ]; then
    log ""
    log "DRY-RUN：未修改任何数据。确认后加 --apply 执行。"
    exit 0
fi

if [ "$USE_SERVICE" -eq 1 ]; then
    if systemctl is-active --quiet "$SERVICE"; then
        SERVICE_WAS_ACTIVE=1
        log ""
        log "[INFO] 停止服务：$SERVICE"
        systemctl stop "$SERVICE" || die "停止服务失败：$SERVICE"
        SERVICE_STOPPED=1
    else
        log "[INFO] 服务 $SERVICE 未运行，跳过停止"
    fi
else
    log "[WARN] --no-service：跳过服务控制，请确认没有进程持有数据库"
fi

mkdir -p "$BACKUP_DIR"
[ -w "$BACKUP_DIR" ] || die "备份目录不可写：$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="$BACKUP_DIR/$(basename "$DB_PATH").purge-users.$STAMP.bak"
[ ! -e "$BACKUP_PATH" ] || die "备份文件已存在：$BACKUP_PATH"

log "[INFO] 备份数据库到：$BACKUP_PATH"
sqlite3 "$DB_PATH" ".backup $(sql_quote "$BACKUP_PATH")" || die "备份失败"
chmod 600 "$BACKUP_PATH" 2>/dev/null || true
chown --reference="$DB_PATH" "$BACKUP_PATH" 2>/dev/null || true

INTEGRITY="$(sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check;")"
[ "$INTEGRITY" = "ok" ] || die "备份完整性检查失败：$INTEGRITY"

log "[INFO] 执行删除（单事务）"
sqlite3 "$DB_PATH" <<SQL
.bail on
PRAGMA foreign_keys=ON;

-- 守卫 1：保留账号必须仍是唯一匹配的 admin
CREATE TEMP TABLE guard_admin(x INTEGER NOT NULL CHECK (x = 1));
INSERT INTO guard_admin
    SELECT COUNT(*) FROM user_account WHERE username = $KEEP_SQL AND role = 'admin';

CREATE TEMP TABLE zombie AS
    SELECT id FROM user_account WHERE username <> $KEEP_SQL;

-- 守卫 2：保留账号的交易不能引用僵尸账号的券商事实行（有 FK，提前给出可读错误）
CREATE TEMP TABLE guard_trade_refs(x INTEGER NOT NULL CHECK (x = 0));
INSERT INTO guard_trade_refs
    SELECT COUNT(*)
    FROM user_trade_record t
    JOIN broker_trade_record b ON b.id = t.source_broker_record_id
    WHERE t.user_id NOT IN (SELECT id FROM zombie)
      AND b.user_id IN (SELECT id FROM zombie);

-- 守卫 3：保留账号的信号不能引用僵尸账号的交易（有 FK）
CREATE TEMP TABLE guard_signal_refs(x INTEGER NOT NULL CHECK (x = 0));
INSERT INTO guard_signal_refs
    SELECT COUNT(*)
    FROM user_strategy_signal s
    JOIN user_trade_record t ON t.id = s.linked_trade_id
    WHERE s.user_id NOT IN (SELECT id FROM zombie)
      AND t.user_id IN (SELECT id FROM zombie);

BEGIN IMMEDIATE;

-- 无 FK 的悬空引用：保留账号的批次指向僵尸模板 -> 置空
UPDATE broker_import_batch
   SET template_id = NULL
 WHERE user_id NOT IN (SELECT id FROM zombie)
   AND template_id IN (
       SELECT id FROM broker_import_template WHERE user_id IN (SELECT id FROM zombie)
   );

-- 无 FK 的悬空引用：保留账号的券商事实行匹配到僵尸交易 -> 解除匹配
UPDATE broker_trade_record
   SET matched_trade_record_id = NULL
 WHERE user_id NOT IN (SELECT id FROM zombie)
   AND matched_trade_record_id IN (
       SELECT id FROM user_trade_record WHERE user_id IN (SELECT id FROM zombie)
   );

-- 子表删除顺序：信号 -> 快照/配置/模板 -> 交易 -> 券商事实 -> 批次 -> 资产关系 -> 账号
DELETE FROM user_strategy_signal    WHERE user_id IN (SELECT id FROM zombie);
DELETE FROM user_asset_stat         WHERE user_id IN (SELECT id FROM zombie);
DELETE FROM user_fee_config         WHERE user_id IN (SELECT id FROM zombie);
DELETE FROM user_plugin_config      WHERE user_id IN (SELECT id FROM zombie);
DELETE FROM broker_import_template  WHERE user_id IN (SELECT id FROM zombie);
DELETE FROM user_trade_record       WHERE user_id IN (SELECT id FROM zombie);
DELETE FROM broker_trade_record     WHERE user_id IN (SELECT id FROM zombie);
DELETE FROM broker_import_batch     WHERE user_id IN (SELECT id FROM zombie);
DELETE FROM user_asset_rel          WHERE user_id IN (SELECT id FROM zombie);

-- asset_class 是全局表：不删分类，只清掉指向僵尸账号的 updated_by
UPDATE asset_class
   SET updated_by = NULL
 WHERE updated_by IN (SELECT id FROM zombie);

DELETE FROM user_account WHERE id IN (SELECT id FROM zombie);

-- 守卫 4：事务内 FK 检查；有任何违规就 abort，整个事务回滚
CREATE TEMP TABLE guard_fk(x INTEGER NOT NULL CHECK (x = 0));
INSERT INTO guard_fk SELECT COUNT(*) FROM pragma_foreign_key_check;

COMMIT;
SQL

LEFT_USERS="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM user_account;")"
LEFT_ADMIN="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM user_account WHERE username = $KEEP_SQL AND role = 'admin';")"
[ "$LEFT_USERS" = "1" ] || die "清理后账号数异常：$LEFT_USERS（备份：$BACKUP_PATH）"
[ "$LEFT_ADMIN" = "1" ] || die "清理后保留账号异常（备份：$BACKUP_PATH）"

if [ "$DO_VACUUM" -eq 1 ]; then
    log "[INFO] VACUUM 回收空间"
    sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;" >/dev/null ||
        log "[WARN] VACUUM 失败（删除已提交，可稍后手动执行）"
fi

log ""
log "=== 清理结果 ==="
sqlite3 -header -column "$DB_PATH" <<SQL
SELECT COUNT(*) AS users_left FROM user_account;
SELECT COUNT(*) AS asset_class_left FROM asset_class;
SELECT COUNT(*) AS orphan_templates
FROM broker_import_template
WHERE user_id NOT IN (SELECT id FROM user_account);
SQL

log ""
log "完成。备份：$BACKUP_PATH"
log "注意：已删除账号的 JWT access token 最长仍有效 7 天；如需立即失效，请更换 JWT_SECRET 并重启服务。"
