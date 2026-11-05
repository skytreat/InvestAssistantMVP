/**
 * 清理业务库数据：只保留指定 admin 账号及其名下业务记录，删除其余用户与数据。
 *
 * 保留项：
 *   - user_account 中指定 admin（role='admin'）
 *   - 该 admin 在 user_trade_record / user_asset_rel / user_strategy_signal /
 *     user_fee_config / user_plugin_config / user_asset_stat / broker_* 中的全部记录
 *   - asset_class（全局分类字典，非用户数据；引用已删用户的 updated_by 置 NULL）
 *   - symbol_dict（由行情层自动重建的字典快照，不动）
 *   - system_log 默认清零（无 user_id，无法按用户区分；--keep-log-days N 可保留最近 N 天）
 *
 * 用法（仓库根目录执行，先停后端）：
 *   node scripts/cleanup-business-data.mjs                        # 预览（不写入）
 *   node scripts/cleanup-business-data.mjs --admin admin          # 指定保留的 admin
 *   node scripts/cleanup-business-data.mjs --admin admin --execute # 备份后执行（system_log 一并清零）
 *   node scripts/cleanup-business-data.mjs --admin admin --execute --keep-log-days 30  # 只留最近 30 天日志
 *   node scripts/cleanup-business-data.mjs --purge-admin --execute # 连 admin 一起清空（全量重置）
 *
 * 选项：
 *   --execute            实际执行（默认只打印计划）；执行前自动生成 `<db>.pre-clean-<时间戳>` 备份
 *   --admin <name>       要保留的 admin 用户名；库中只有一个 admin 时可省略
 *   --purge-admin        连 admin 账号及其数据一起删除（user_account 清空）；首次注册会自动重建 admin
 *   --keep-log-days <n>  保留最近 n 天 system_log（默认 0 = 清零；n 需为非负整数）
 *   --db <path>          指定 SQLite 路径（默认 SQLITE_DB_PATH，再默认 data/business.db）
 *   --env <path>         指定环境变量文件（默认依次尝试 .env.local / apps/backend/.env.local）
 *
 * 注意：参数与值之间必须用空格分隔（`--db <path>` / `--env <path>`）；
 *       写成等号形式 `--db=<path>` / `--env=<path>` 不会被识别，将静默回落到默认库 / 默认 env 查找。
 *       `--env` 指定的文件不存在或不可读时会打印警告，仍按上述默认逻辑回落（不退出）。
 *       预览（不带 `--execute`）以「读写打开 + 立即 `PRAGMA query_only = ON`」实现：统计查询前已禁止写入，
 *       运行期可能短暂创建 `-wal`/`-shm`，连接正常关闭后由 SQLite 自动清理；
 *       进程被强杀（Ctrl+C / kill -9）时可能残留，需手工清理或下次正常连接时自动处理。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0] + '*/');
  process.exit(0);
}

const execute = args.includes('--execute');
const purgeAdmin = args.includes('--purge-admin');
const adminArg = readArg('--admin');
const keepLogDaysRaw = readArg('--keep-log-days');
const keepLogDays = keepLogDaysRaw === null ? 0 : Number(keepLogDaysRaw);
const envArg = readArg('--env');
const dbArg = readArg('--db');

function readArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

function loadEnvFile(p) {
  try {
    const fullPath = resolve(p);
    if (!existsSync(fullPath)) return false;
    const content = readFileSync(fullPath, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
      }
    }
    return true;
  } catch {
    return false;
  }
}

if (envArg) {
  if (!loadEnvFile(envArg)) {
    console.warn(
      `⚠️ --env 指定的环境变量文件不可用（不存在或不可读）：${resolve(envArg)}，将回落到默认 env 查找 / 默认库。`,
    );
  }
} else {
  loadEnvFile('.env.local');
  loadEnvFile('apps/backend/.env.local');
}

if (!Number.isInteger(keepLogDays) || keepLogDays < 0) {
  console.error('\n❌ --keep-log-days 需为非负整数（0 = 清零 system_log）。');
  process.exit(1);
}

const dbPath = resolve(dbArg ?? process.env.SQLITE_DB_PATH ?? 'data/business.db');

/** 有 user_id 的表：删除顺序 = 数组顺序（子表在前，父表在后） */
const PER_USER_TABLES = [
  'user_strategy_signal', // linked_trade_id -> user_trade_record
  'user_trade_record', // source_broker_record_id -> broker_trade_record
  'broker_trade_record',
  'broker_import_batch',
  'broker_import_template',
  'user_asset_rel',
  'user_fee_config',
  'user_plugin_config',
  'user_asset_stat',
];

const SPECIAL_TABLES = ['asset_class'];

console.log(`SQLite: ${dbPath}`);
console.log(`模式: ${execute ? '执行清理' : '预览（不写入）'}`);

if (!existsSync(dbPath)) {
  console.error(`\n❌ 数据库不存在：${dbPath}`);
  process.exit(1);
}

const db = (() => {
  try {
    // 预览用「读写打开 + query_only」：读写连接干净关闭时 SQLite 会自清 sidecar；query_only 挡住一切写入。
    const handle = new Database(dbPath);
    handle.pragma(`query_only = ${execute ? 'OFF' : 'ON'}`);
    // SQLite 延迟到首条语句才初始化 WAL sidecar，这里先探一次，让 CANTOPEN 在本处暴露。
    handle.prepare('SELECT 1 AS ok').get();
    return handle;
  } catch (err) {
    console.error(`\n❌ 打开数据库失败（${err.code ?? 'UNKNOWN'}）：${err.message}`);
    if (!execute) {
      console.error(
        '   预览以读写方式打开（随后立即 query_only）：需要数据库目录可写，用于短暂创建 -shm/-wal；',
      );
      console.error('   若以只读身份运行或目录不可写，会以 SQLITE_CANTOPEN 中止。');
      console.error('   如需在只读挂载上预览，请先把库文件复制到可写目录，再用 --db <副本路径> 运行。');
    }
    process.exit(1);
  }
})();
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const tableExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columnsOf = (name) => db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
const countAll = (name) => db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`).get().c;

// ---------- 选择要保留的 admin（--purge-admin 时一个都不保留） ----------
if (purgeAdmin && adminArg) {
  console.error('\n❌ --purge-admin 与 --admin 互斥：要么保留一个 admin，要么连 admin 一起清空。');
  db.close();
  process.exit(1);
}

let admin = null;
if (!purgeAdmin) {
  const admins = db.prepare("SELECT id, username FROM user_account WHERE role = 'admin' ORDER BY id").all();

  if (admins.length === 0) {
    console.error(
      '\n❌ 库中没有 admin 用户，拒绝执行（避免把库清成无管理员状态；确需清空请加 --purge-admin）。',
    );
    db.close();
    process.exit(1);
  }

  if (!adminArg && admins.length > 1) {
    console.error('\n❌ 存在多个 admin，请用 --admin <username> 指定要保留的一个：');
    for (const a of admins) console.error(`   id=${a.id}  ${a.username}`);
    db.close();
    process.exit(1);
  }

  admin = adminArg
    ? db.prepare('SELECT id, username FROM user_account WHERE username = ?').get(adminArg)
    : admins[0];

  if (!admin) {
    console.error(`\n❌ 找不到用户：${adminArg}`);
    db.close();
    process.exit(1);
  }
  const adminRole = db.prepare('SELECT role FROM user_account WHERE id = ?').get(admin.id)?.role;
  if (adminRole !== 'admin') {
    console.error(`\n❌ 用户 ${admin.username} 的 role=${adminRole}，不是 admin，拒绝执行。`);
    db.close();
    process.exit(1);
  }

  console.log(`保留 admin: id=${admin.id} username=${admin.username}\n`);
} else {
  console.log('保留 admin: 无（--purge-admin：账号与数据全部清空）\n');
}

/** 保留的用户 id；--purge-admin 时为 null（不保留任何用户） */
const keepUserId = admin ? admin.id : null;

// ---------- 识别需要处理的表 ----------
const allTables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r) => r.name);

const perUserTables = [];
for (const name of allTables) {
  if (name === 'user_account') continue;
  if (!columnsOf(name).some((c) => c.name === 'user_id')) continue;
  perUserTables.push(name);
}

const unknownTables = perUserTables.filter((t) => !PER_USER_TABLES.includes(t));
const deleteOrder = [...unknownTables, ...PER_USER_TABLES.filter(tableExists)];

// 引用 user_account 但既无 user_id 也不在 SPECIAL 里的表：无法按用户过滤，直接拒绝
const unhandledRefs = allTables.filter((name) => {
  if (name === 'user_account' || perUserTables.includes(name) || SPECIAL_TABLES.includes(name)) {
    return false;
  }
  return db
    .prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`)
    .all()
    .some((fk) => fk.table === 'user_account');
});

if (unhandledRefs.length > 0) {
  console.error(
    `\n❌ 以下表引用 user_account 但无法按 user_id 过滤，请先人工处理：${unhandledRefs.join(', ')}`,
  );
  db.close();
  process.exit(1);
}

if (unknownTables.length > 0) {
  const scope = keepUserId === null ? '清空全部行' : '仅保留 admin 行';
  console.warn(`⚠️ 发现未登记的用户表（将一并清理，${scope}）：${unknownTables.join(', ')}\n`);
}

// ---------- 统计 ----------
const plan = [];
for (const name of deleteOrder) {
  const total = countAll(name);
  const keep =
    keepUserId === null
      ? 0
      : db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)} WHERE user_id = ?`).get(keepUserId).c;
  plan.push({ table: name, total, keep, remove: total - keep });
}

const usersTotal = countAll('user_account');
const usersKeep = keepUserId === null ? 0 : 1;
const usersRemove = usersTotal - usersKeep;

const hasAssetClass =
  tableExists('asset_class') && columnsOf('asset_class').some((c) => c.name === 'updated_by');
const assetClassDeref = hasAssetClass
  ? keepUserId === null
    ? db.prepare('SELECT COUNT(*) AS c FROM asset_class WHERE updated_by IS NOT NULL').get().c
    : db
        .prepare('SELECT COUNT(*) AS c FROM asset_class WHERE updated_by IS NOT NULL AND updated_by <> ?')
        .get(keepUserId).c
  : 0;

const logsTotal = tableExists('system_log') ? countAll('system_log') : 0;
const logsKeep =
  logsTotal === 0 || keepLogDays === 0
    ? 0
    : db
        .prepare("SELECT COUNT(*) AS c FROM system_log WHERE created_at >= datetime('now', ?, 'localtime')")
        .get(`-${keepLogDays} days`).c;
const logsRemove = logsTotal - logsKeep;

console.log('表'.padEnd(28) + '总行数'.padStart(8) + '保留'.padStart(8) + '删除'.padStart(8));
console.log('-'.repeat(52));
console.log(
  'user_account'.padEnd(28) +
    String(usersTotal).padStart(8) +
    String(usersKeep).padStart(8) +
    String(usersRemove).padStart(8),
);
for (const p of plan) {
  console.log(
    p.table.padEnd(28) +
      String(p.total).padStart(8) +
      String(p.keep).padStart(8) +
      String(p.remove).padStart(8),
  );
}
console.log('-'.repeat(52));
console.log(`asset_class.updated_by 置 NULL（保留分类数据）：${assetClassDeref} 行`);
console.log(`symbol_dict：保留（行情层自动重建的字典快照）`);
console.log(
  `system_log：保留 ${logsKeep} 行 / 删除 ${logsRemove} 行` +
    (keepLogDays === 0 ? '（默认清零）' : `（--keep-log-days ${keepLogDays}）`),
);

if (!execute) {
  console.log('\n预览模式，未修改数据库。确认无误后加 --execute 执行。');
  db.close();
  process.exit(0);
}

// ---------- 写锁预检 ----------
// 先取一次写锁再立刻释放：若后端还在跑（或其他进程持有写锁），这里就会在 busy_timeout 后失败，
// 此时**尚未生成备份**、库也未被修改，不会出现「备份了但没清成」的误导状态。
try {
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
} catch (err) {
  console.error('\n❌ 数据库正被其他进程占用（请先停后端再执行）：', err.message);
  db.close();
  process.exit(1);
}

// ---------- 备份 ----------
// `.mjs` 是 ESM，顶层 await 可用（`db.backup()` 返回 Promise）；备份失败必须中止，不能带着无备份的库去删数据。
const backupPath = `${dbPath}.pre-clean-${Date.now()}`;
try {
  await db.backup(backupPath);
  console.log(`\n已备份到：${backupPath}`);
} catch (err) {
  console.error('\n❌ 备份失败，已中止（未修改数据库）：', err.message);
  db.close();
  process.exit(1);
}

// ---------- 执行清理（单事务） ----------
// 用 IMMEDIATE 在事务开始就取写锁：避免「先读后升级为写」时被其他进程插队导致 SQLITE_BUSY，
// 也让「后端还在跑」这种情况在 busy_timeout（5s）后明确失败回滚，而不是删到一半。
const tx = db.transaction(() => {
  if (keepUserId !== null) {
    // 防御：admin 记录若误引用将被删除的跨用户记录，先断链，避免 FK 失败
    db.prepare(
      `UPDATE user_strategy_signal SET linked_trade_id = NULL
       WHERE linked_trade_id IN (SELECT id FROM user_trade_record WHERE user_id <> ?)`,
    ).run(keepUserId);
    db.prepare(
      `UPDATE user_trade_record SET source_broker_record_id = NULL
       WHERE user_id = ? AND source_broker_record_id IN
         (SELECT id FROM broker_trade_record WHERE user_id <> ?)`,
    ).run(keepUserId, keepUserId);
  }
  if (hasAssetClass) {
    db.prepare(
      keepUserId === null
        ? 'UPDATE asset_class SET updated_by = NULL WHERE updated_by IS NOT NULL'
        : 'UPDATE asset_class SET updated_by = NULL WHERE updated_by IS NOT NULL AND updated_by <> ?',
    ).run(...(keepUserId === null ? [] : [keepUserId]));
  }

  for (const name of deleteOrder) {
    db.prepare(
      keepUserId === null
        ? `DELETE FROM ${quoteIdent(name)}`
        : `DELETE FROM ${quoteIdent(name)} WHERE user_id IS NULL OR user_id <> ?`,
    ).run(...(keepUserId === null ? [] : [keepUserId]));
  }
  db.prepare(keepUserId === null ? 'DELETE FROM user_account' : 'DELETE FROM user_account WHERE id <> ?').run(
    ...(keepUserId === null ? [] : [keepUserId]),
  );

  // system_log 默认清零；--keep-log-days N 只保留最近 N 天（created_at 为本地时间字符串）
  if (tableExists('system_log')) {
    if (keepLogDays === 0) db.prepare('DELETE FROM system_log').run();
    else
      db.prepare("DELETE FROM system_log WHERE created_at < datetime('now', ?, 'localtime')").run(
        `-${keepLogDays} days`,
      );
  }

  // 重置 AUTOINCREMENT 序列，避免清理后 id 从历史最大值继续跳号
  const seqTables = [...deleteOrder, 'user_account', 'system_log'];
  const hasSeq = tableExists('sqlite_sequence');
  if (hasSeq) {
    for (const name of seqTables) {
      if (!tableExists(name)) continue;
      if (!db.prepare('SELECT 1 FROM sqlite_sequence WHERE name = ?').get(name)) continue;
      db.prepare(
        `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM ${quoteIdent(name)}) WHERE name = ?`,
      ).run(name);
    }
  }
});

try {
  tx.immediate();
  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('\n✅ 清理完成。');
  console.log(
    keepUserId === null
      ? '保留：无（--purge-admin，user_account 已清空）；业务记录已按上表清空。'
      : `保留：admin=${admin.username}（id=${admin.id}）；业务记录已按上表收缩。`,
  );
  console.log(
    '提示：如担心旧 access token 仍有效（JWT 有效期 7 天），请更换 .env.local 的 JWT_SECRET 并重启后端。',
  );
} catch (err) {
  console.error('\n❌ 清理失败，事务已回滚：', err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
