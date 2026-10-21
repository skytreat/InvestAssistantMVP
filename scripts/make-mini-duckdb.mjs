#!/usr/bin/env node
/**
 * 迷你 DuckDB 行情库生成器（mini market DB builder）
 *
 * 🔴 **为什么需要它**（2026-10-21 实测）：
 *   CI 环境只有 12KB 的**空壳**行情库（`data/quotes.duckdb`，无 `v_stock_qfq` 表），
 *   于是「依赖真实行情数据」的用例在**本地全绿、CI 全红**（PR #15 后续 24 个 commit
 *   从未过 CI）。真库 1.24GB 又不能进 git。
 *   → 解法：**抽样出一份迷你库**（250 只标的 / 242 根日线 / 6 张视图），
 *     以 **Parquet**（不是二进制 .duckdb）入库，测试前现生成 .duckdb。
 *
 * ── 三档切换（见 apps/backend/tests/_marketData.ts）────────────────────────
 *   dev 档：磁盘上已有迷你库 → 直接用
 *   CI  档：每次现生成（临时目录）
 *   full 档：真库（显式指定 DUCKDB_PATH）
 *
 * ── 两层开关 ────────────────────────────────────────────────────────────
 *   数值型（numeric）：迷你库**可信** —— 它是从真库**原样抽样**的，数值口径与真库一致
 *   规模型+性能型（scale/performance）：**必须真库** —— 迷你库只有 250 只标的，
 *     既撑不起「5000 候选」也测不出「≤3s」
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   # ① 从真库抽取（写 Parquet + manifest）—— 需要本机有真库
 *   node scripts/make-mini-duckdb.mjs extract \
 *     --source /opt/invol/quotes.duckdb \
 *     --out apps/backend/tests/fixtures/mini-market
 *
 *   # ② 由 Parquet 构建迷你 .duckdb（**不需要真库** —— CI 走这条）
 *   node scripts/make-mini-duckdb.mjs build \
 *     --parquet apps/backend/tests/fixtures/mini-market \
 *     --out data/quotes.mini.duckdb
 *
 *   # ③ 一步到位（本机有真库时）
 *   node scripts/make-mini-duckdb.mjs all --source /opt/invol/quotes.duckdb
 *
 * ⚠️ **真库只读打开**，本脚本**从不写**真库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * 解析 `@duckdb/node-api`
 *
 * ⚠️ **不能只依赖根 node_modules**：npm workspaces 的 hoist 行为不是契约 ——
 *   若 `@duckdb/node-api` 被装在 `apps/backend/node_modules` 下（版本冲突时不 hoist），
 *   从 `scripts/` 向上找就找不到。故这里按「根 → 后端 workspace」顺序兜底。
 */
function loadDuckDB() {
  const candidates = [
    () => require('@duckdb/node-api'),
    () => createRequire(path.join(REPO_ROOT, 'apps/backend/package.json'))('@duckdb/node-api'),
  ];
  let lastErr;
  for (const load of candidates) {
    try {
      return load();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `找不到 @duckdb/node-api（先跑 npm ci）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

const { DuckDBInstance } = loadDuckDB();

// ── 规格（已定案，见任务书）────────────────────────────────────────────────
/** 迷你库标的总量 */
const TOTAL_SYMBOLS = 250;
/** 时间窗口：365 自然日（实测 = 242 个交易日；半年 119 根不够 golden 的 221 根） */
const WINDOW_DAYS = 365;
/** 真库的 class 真实比例（12449 只实测：stock 6158 / etf 2839 / unknown 1357 / block 1128 / index 801 / bstock 166） */
const CLASS_RATIO = {
  stock: 0.4947,
  etf: 0.228,
  unknown: 0.109,
  block: 0.0906,
  index: 0.0643,
  bstock: 0.0133,
};
/** 需要重建的 6 张视图 */
const VIEW_NAMES = ['v_etf_bfq', 'v_etf_hfq', 'v_etf_qfq', 'v_stock_bfq', 'v_stock_hfq', 'v_stock_qfq'];
/** 需要复刻的表（raw_kline_1min 实测 0 行、tdx_blocks_* 实测 0 行 —— 建空表保结构） */
const TABLES = [
  'raw_kline_daily',
  'raw_adjust_factor',
  'raw_basic_daily',
  'raw_symbol_class',
  'raw_symbol_name',
  'raw_holidays',
  'raw_gbbq',
  'raw_kline_1min',
  'raw_tdx_blocks_info',
  'raw_tdx_blocks_member',
];

// ── 参数解析 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { command: argv[2] ?? 'help' };
  for (let i = 3; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const val = argv[i + 1];
    if (key) args[key] = val;
  }
  return args;
}

/** FNV-1a 32bit —— **确定性**哈希（不是随机）⇒ 抽样可复现 */
function hashSymbol(symbol) {
  let h = 0x811c9dc5;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * 收集「测试/源码里引用到的标的代码」
 *
 * ⚠️ 为什么要扫仓库而不是写死列表：写死的列表会随新测试漂移。
 *   扫仓库 → 新增测试引用了新标的，下次抽取自动带上。
 */
function collectReferencedSymbols() {
  const roots = ['apps/backend/tests', 'apps/backend/src', 'packages/core'];
  const found = new Set();
  const re = /\b(?:sh|sz|bj)\d{6}\b/g;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        walk(full);
      } else if (/\.(ts|tsx|js|mjs|json)$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf-8');
        for (const m of text.matchAll(re)) found.add(m[0]);
      }
    }
  };
  for (const r of roots) walk(path.join(REPO_ROOT, r));
  return [...found].sort();
}

// ── DuckDB 小工具 ─────────────────────────────────────────────────────────
/** 打开（只读）并跑查询，返回行数组 */
async function queryRows(dbPath, sql, params = [], readOnly = true) {
  const inst = await DuckDBInstance.create(dbPath, readOnly ? { access_mode: 'READ_ONLY' } : {});
  try {
    const conn = await inst.connect();
    try {
      const res = await conn.runAndReadAll(sql, params);
      const names = res.columnNames();
      return res.getRows().map((row) => {
        const obj = {};
        names.forEach((n, i) => {
          obj[n] = row[i];
        });
        return obj;
      });
    } finally {
      conn.closeSync();
    }
  } finally {
    inst.closeSync();
  }
}

// ════════════════════════════════════════════════════════════════════════
// ① extract —— 从真库抽 Parquet + manifest
// ════════════════════════════════════════════════════════════════════════
async function extract(args) {
  const source = path.resolve(args.source ?? process.env.DUCKDB_PATH ?? '/opt/invol/quotes.duckdb');
  const outDir = path.resolve(args.out ?? path.join(REPO_ROOT, 'apps/backend/tests/fixtures/mini-market'));
  if (!fs.existsSync(source)) {
    throw new Error(`真库不存在：${source}（extract 需要本机有真实行情库）`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[extract] 源库（只读）：${source}`);
  console.log(`[extract] 输出目录：${outDir}`);

  // ---- 1. 视图定义（从真库 duckdb_views() 导出）----
  // ⚠️ 用 starts_with 而不是 LIKE 'v\_%'：DuckDB 的 LIKE **不把反斜杠当转义符**
  //    （实测 LIKE 'v\_%' 返回 0 行，LIKE 'v_%' 返回 7 行含系统视图，starts_with 返回 6 行）
  const viewRows = await queryRows(
    source,
    `SELECT view_name, sql FROM duckdb_views()
      WHERE starts_with(view_name, 'v_') AND view_name IN (${VIEW_NAMES.map(() => '?').join(',')})
      ORDER BY view_name`,
    VIEW_NAMES,
  );
  if (viewRows.length !== VIEW_NAMES.length) {
    throw new Error(
      `真库视图不齐：期望 ${VIEW_NAMES.length} 张，实得 ${viewRows.length} 张（${viewRows.map((r) => r.view_name).join(',')}）`,
    );
  }
  const viewDefs = Object.fromEntries(viewRows.map((r) => [r.view_name, r.sql]));
  console.log(`[extract] 导出 ${viewRows.length} 张视图定义`);

  // ---- 2. 表 DDL（保结构，空表也建）----
  const ddlRows = await queryRows(
    source,
    `SELECT table_name, sql FROM duckdb_tables() WHERE table_name IN (${TABLES.map(() => '?').join(',')})`,
    TABLES,
  );
  const tableDdl = Object.fromEntries(ddlRows.map((r) => [r.table_name, r.sql]));

  // ---- 3. 时间窗口（以真库最新行情日为右端）----
  const maxDateRows = await queryRows(source, `SELECT MAX(date) AS d FROM raw_kline_daily`);
  const maxDate = String(maxDateRows[0].d).slice(0, 10);
  const windowStartRows = await queryRows(
    source,
    `SELECT MIN(date) AS d FROM raw_kline_daily WHERE date > (?::DATE - INTERVAL ${WINDOW_DAYS} DAY) AND date <= ?::DATE`,
    [maxDate, maxDate],
  );
  const windowStart = String(windowStartRows[0].d).slice(0, 10);
  const tradingDays = await queryRows(
    source,
    `SELECT COUNT(DISTINCT date) AS c FROM raw_kline_daily WHERE date > (?::DATE - INTERVAL ${WINDOW_DAYS} DAY) AND date <= ?::DATE`,
    [maxDate, maxDate],
  );
  console.log(
    `[extract] 时间窗口 ${windowStart} .. ${maxDate}（${WINDOW_DAYS} 自然日 = ${tradingDays[0].c} 个交易日）`,
  );

  // ---- 4. 标的选取：必选（测试引用）+ 按真库 class 比例补足 ----
  const referenced = collectReferencedSymbols();
  const classRows = await queryRows(source, `SELECT symbol, "class" FROM raw_symbol_class ORDER BY symbol`);
  const classOf = new Map(classRows.map((r) => [r.symbol, r.class]));
  const byClass = new Map();
  for (const r of classRows) {
    if (!byClass.has(r.class)) byClass.set(r.class, []);
    byClass.get(r.class).push(r.symbol);
  }

  const mandatory = referenced.filter((s) => classOf.has(s)).sort();
  const missing = referenced.filter((s) => !classOf.has(s)).sort();
  console.log(
    `[extract] 测试引用标的 ${referenced.length} 个 → 真库存在 ${mandatory.length} 个（必选），缺失 ${missing.length} 个`,
  );

  // 目标：每个 class 按真库比例取 round(ratio * TOTAL)，再用必选抵扣
  const targets = {};
  let assigned = 0;
  for (const [cls, ratio] of Object.entries(CLASS_RATIO)) {
    targets[cls] = Math.round(ratio * TOTAL_SYMBOLS);
    assigned += targets[cls];
  }
  // 舍入误差补齐到 TOTAL_SYMBOLS
  const diff = TOTAL_SYMBOLS - assigned;
  if (diff !== 0) {
    const biggest = Object.keys(targets).sort((a, b) => targets[b] - targets[a])[0];
    targets[biggest] += diff;
  }

  const mandatoryByClass = {};
  for (const s of mandatory) {
    const c = classOf.get(s);
    mandatoryByClass[c] = (mandatoryByClass[c] ?? 0) + 1;
  }

  const selected = new Set(mandatory);
  const fillLog = [];
  for (const [cls, target] of Object.entries(targets)) {
    const already = mandatoryByClass[cls] ?? 0;
    let need = target - already;
    const pool = (byClass.get(cls) ?? [])
      .filter((s) => !selected.has(s))
      // 🔴 **确定性排序**（hash(symbol)）—— 不是随机 ⇒ 每次抽取结果完全一致，可复现
      .sort((a, b) => hashSymbol(a) - hashSymbol(b) || (a < b ? -1 : a > b ? 1 : 0));
    if (need < 0) {
      // 必选数量超过比例目标（不可避免）→ 全留，不再补
      fillLog.push({ class: cls, target, mandatory: already, filled: 0, note: '必选超额' });
      continue;
    }
    const take = pool.slice(0, need);
    for (const s of take) selected.add(s);
    fillLog.push({ class: cls, target, mandatory: already, filled: take.length, note: '' });
  }
  const symbols = [...selected].sort();
  console.log(`[extract] 选中标的 ${symbols.length} 个（目标 ${TOTAL_SYMBOLS}）`);
  for (const f of fillLog) {
    console.log(
      `[extract]   ${f.class.padEnd(8)} 目标 ${String(f.target).padStart(3)} = 必选 ${String(f.mandatory).padStart(3)} + 补足 ${String(f.filled).padStart(3)}${f.note ? '  ⚠️ ' + f.note : ''}`,
    );
  }

  // ---- 5. 导出 Parquet ----
  const symList = symbols.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  const parquetPath = (t) => path.join(outDir, `${t}.parquet`);

  const exports = [
    {
      table: 'raw_kline_daily',
      sql: `SELECT * FROM raw_kline_daily WHERE symbol IN (${symList}) AND date > '${windowStart}' AND date <= '${maxDate}'`,
    },
    {
      table: 'raw_adjust_factor',
      sql: `SELECT * FROM raw_adjust_factor WHERE symbol IN (${symList}) AND date > '${windowStart}' AND date <= '${maxDate}'`,
    },
    {
      table: 'raw_basic_daily',
      sql: `SELECT * FROM raw_basic_daily WHERE symbol IN (${symList}) AND date > '${windowStart}' AND date <= '${maxDate}'`,
    },
    { table: 'raw_symbol_class', sql: `SELECT * FROM raw_symbol_class WHERE symbol IN (${symList})` },
    { table: 'raw_symbol_name', sql: `SELECT * FROM raw_symbol_name WHERE symbol IN (${symList})` },
    {
      // ⚠️ raw_holidays **没有 symbol 列**（实测 schema: 只有 date）⇒ 不能按 symbol 切片 → 取全表
      table: 'raw_holidays',
      sql: `SELECT * FROM raw_holidays`,
    },
    {
      table: 'raw_gbbq',
      sql: `SELECT * FROM raw_gbbq WHERE symbol IN (${symList}) AND date > '${windowStart}' AND date <= '${maxDate}'`,
    },
    { table: 'raw_kline_1min', sql: `SELECT * FROM raw_kline_1min` },
    { table: 'raw_tdx_blocks_info', sql: `SELECT * FROM raw_tdx_blocks_info` },
    { table: 'raw_tdx_blocks_member', sql: `SELECT * FROM raw_tdx_blocks_member` },
  ];

  // 用**只读**连接把 COPY 导出去（COPY ... TO 只写 Parquet 文件，**不碰真库**）
  const inst = await DuckDBInstance.create(source, { access_mode: 'READ_ONLY' });
  try {
    const conn = await inst.connect();
    try {
      for (const e of exports) {
        const target = parquetPath(e.table);
        if (fs.existsSync(target)) fs.rmSync(target);
        await conn.run(
          `COPY (${e.sql}) TO '${target.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
        );
        const size = fs.statSync(target).size;
        console.log(
          `[extract]   ${e.table.padEnd(22)} → ${path.basename(target)} (${(size / 1024).toFixed(0)} KB)`,
        );
      }
    } finally {
      conn.closeSync();
    }
  } finally {
    inst.closeSync();
  }

  // ---- 6. manifest ----
  const manifest = {
    generatedAt: new Date().toISOString(),
    source,
    totalSymbols: symbols.length,
    window: {
      start: windowStart,
      end: maxDate,
      naturalDays: WINDOW_DAYS,
      tradingDays: Number(tradingDays[0].c),
    },
    classRatio: CLASS_RATIO,
    classFill: fillLog,
    referencedSymbols: {
      total: referenced.length,
      mandatoryPresent: mandatory.length,
      missingInSource: missing,
    },
    symbols,
    tableDdl,
    viewDefs,
    tables: TABLES,
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[extract] manifest → ${manifestPath}`);

  return manifest;
}

// ════════════════════════════════════════════════════════════════════════
// ② build —— 由 Parquet + manifest 构建迷你 .duckdb
// ════════════════════════════════════════════════════════════════════════
async function build(args) {
  const parquetDir = path.resolve(
    args.parquet ?? path.join(REPO_ROOT, 'apps/backend/tests/fixtures/mini-market'),
  );
  const outFile = path.resolve(args.out ?? path.join(REPO_ROOT, 'data/quotes.mini.duckdb'));
  const manifestPath = path.join(parquetDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`找不到 manifest：${manifestPath}（先跑 extract，或把 Parquet 目录一起提交）`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  for (const suffix of ['', '.wal']) {
    if (fs.existsSync(outFile + suffix)) fs.rmSync(outFile + suffix);
  }

  console.log(`[build] Parquet 目录：${parquetDir}`);
  console.log(`[build] 输出库：${outFile}`);

  const counts = {};
  const inst = await DuckDBInstance.create(outFile);
  try {
    const conn = await inst.connect();
    try {
      // ---- 建表（DDL 来自 manifest，保结构；数据来自 Parquet）----
      for (const table of manifest.tables) {
        const ddl = manifest.tableDdl[table];
        const pq = path.join(parquetDir, `${table}.parquet`);
        if (!ddl) {
          console.warn(`[build]   ⚠️ manifest 里没有 ${table} 的 DDL —— 跳过`);
          continue;
        }
        if (!fs.existsSync(pq)) {
          console.warn(`[build]   ⚠️ 缺少 ${table}.parquet —— 只建空表`);
          await conn.run(ddl);
          continue;
        }
        await conn.run(ddl);
        await conn.run(`INSERT INTO ${table} SELECT * FROM read_parquet('${pq.replace(/'/g, "''")}')`);
      }

      // ---- 重建 6 张视图（定义来自真库导出 → 与真库**逐字一致**）----
      for (const view of VIEW_NAMES) {
        const sql = manifest.viewDefs[view];
        if (!sql) throw new Error(`manifest 缺少视图定义：${view}`);
        await conn.run(sql);
      }

      // ---- 校验：视图可查 + 行数 ----
      const vcheck = await conn.runAndReadAll(
        `SELECT COUNT(*) AS c FROM duckdb_views() WHERE starts_with(view_name,'v_')`,
      );
      const vcount = Number(vcheck.getRows()[0][0]);
      console.log(`[build] 视图重建：${vcount} 张（期望 6）`);
      if (vcount !== 6) throw new Error(`视图重建数量不对：${vcount} ≠ 6`);

      for (const table of manifest.tables) {
        const r = await conn.runAndReadAll(`SELECT COUNT(*) AS c FROM ${table}`);
        counts[table] = Number(r.getRows()[0][0]);
      }
      const kw = await conn.runAndReadAll(
        `SELECT COUNT(*) AS c FROM v_stock_qfq WHERE date > '${manifest.window.start}' AND date <= '${manifest.window.end}'`,
      );
      counts['v_stock_qfq(window)'] = Number(kw.getRows()[0][0]);
      console.log('[build] 行数：');
      for (const [t, c] of Object.entries(counts)) {
        console.log(`[build]   ${t.padEnd(24)} ${c}`);
      }
    } finally {
      conn.closeSync();
    }
  } finally {
    inst.closeSync();
  }

  const size = fs.statSync(outFile).size;
  console.log(`[build] 完成：${outFile}（${(size / 1024 / 1024).toFixed(2)} MB）`);
  return { outFile, size, counts };
}

// ════════════════════════════════════════════════════════════════════════
const args = parseArgs(process.argv);
try {
  if (args.command === 'extract') {
    await extract(args);
  } else if (args.command === 'build') {
    await build(args);
  } else if (args.command === 'all') {
    const manifest = await extract(args);
    await build({
      ...args,
      parquet: args.out ?? path.join(REPO_ROOT, 'apps/backend/tests/fixtures/mini-market'),
    });
    console.log(`[all] 标的数 ${manifest.symbols.length}`);
  } else {
    console.log(
      [
        '用法：',
        '  node scripts/make-mini-duckdb.mjs extract --source <真库> --out <Parquet 目录>',
        '  node scripts/make-mini-duckdb.mjs build   --parquet <Parquet 目录> --out <迷你 .duckdb>',
        '  node scripts/make-mini-duckdb.mjs all     --source <真库>',
      ].join('\n'),
    );
    process.exit(1);
  }
} catch (err) {
  console.error('[make-mini-duckdb] 失败：', err instanceof Error ? err.message : err);
  process.exit(1);
}
