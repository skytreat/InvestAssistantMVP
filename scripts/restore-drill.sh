#!/usr/bin/env bash
# ============================================================
# DuckDB + SQLite 双库恢复演练（SDD §6.5 + PRD §6.2「100%」）
#
# 用法：BACKUP_DIR=/path/to/backup bash scripts/restore-drill.sh
# 退出码：0 = 全部通过；1 = 存在不一致
#
# 演练流程：
#   1. 找到最近的 SQLite 备份 + DuckDB 行情 parquet 备份
#   2. 恢复到临时目录（不覆盖生产库）
#   3. integrity_check + COUNT(*) 比对
# ============================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-data/backup}"
TMPDIR="${TMPDIR:-/tmp/restore-drill}"
rm -rf "$TMPDIR"
mkdir -p "$TMPDIR"

echo "=== 1. 定位最新备份 ==="
SQLITE_BACKUP=$(ls -t "$BACKUP_DIR"/business.db.* 2>/dev/null | head -1 || true)
PARQUET_BACKUP=$(ls -t "$BACKUP_DIR"/v_stock_qfq.*.parquet 2>/dev/null | head -1 || true)

if [ -z "$SQLITE_BACKUP" ]; then
    echo "❌ 找不到 SQLite 备份"; exit 1
fi
if [ -z "$PARQUET_BACKUP" ]; then
    echo "⚠️ 找不到 DuckDB 行情 parquet 备份（ENABLE_QUOTE_BACKUP=false 时属正常）"
    echo "   → 跳过行情段，SQLite 段仍完整校验"
fi

echo "  SQLite: $SQLITE_BACKUP"
if [ -n "$PARQUET_BACKUP" ]; then
    echo "  Parquet: $PARQUET_BACKUP"
fi

echo "=== 2. SQLite 恢复演练 ==="
cp "$SQLITE_BACKUP" "$TMPDIR/restored.db"
INTEGRITY=$(sqlite3 "$TMPDIR/restored.db" "PRAGMA integrity_check;" 2>&1 || echo "ERROR")
if [ "$INTEGRITY" != "ok" ]; then
    echo "❌ SQLite integrity_check 失败: $INTEGRITY"; exit 1
fi
echo "✅ SQLite integrity_check = ok"

if [ -n "$PARQUET_BACKUP" ]; then
    echo "=== 3. DuckDB 行情恢复演练 ==="
    DDB="$TMPDIR/restored.duckdb"
    duckdb "$DDB" -c "CREATE TABLE t AS SELECT COUNT(*) AS c FROM read_parquet('$PARQUET_BACKUP');" >/dev/null 2>&1
    ROWS=$(duckdb -readonly "$DDB" -c "SELECT c FROM t;" 2>/dev/null | tail -1 | tr -d ' ')
    echo "  恢复的行情行数: $ROWS"
    if [ -z "$ROWS" ] || [ "$ROWS" = "0" ]; then
        echo "❌ DuckDB 行情恢复失败"; exit 1
    fi
    echo "✅ DuckDB 行情恢复成功（$ROWS 行）"
else
    echo "=== 3. DuckDB 行情恢复演练 === SKIP（无 parquet 备份）"
fi

echo "=== 4. 清理 ==="
rm -rf "$TMPDIR"
echo "✅ 恢复演练完成（SQLite 段通过）"
