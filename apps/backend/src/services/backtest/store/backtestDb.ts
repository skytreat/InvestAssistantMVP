/**
 * 回测结果库（M2）—— `data/backtest.db`（**独立库**，绝不写 `data/business.db`）
 *
 * 依据 proposal §3.9 表结构：`bt_run / bt_equity / bt_trade / bt_round_trip /
 * bt_attribution / bt_trial / bt_metric`。M2 只写入前 4 张 + `bt_metric`；
 * `bt_attribution`（M3 归因）与 `bt_trial`（M4 寻优）先建表留位。
 *
 * ⚠️ 与业务库的边界：
 *   - 业务库（`data/business.db`）由 `ConfigStore` 独占；本文件**不 import 任何业务 DB 模块**
 *   - 回测库可随时删除重建（`data/backtest.db` 已在 `.gitignore` 的 `data/` 下）
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BacktestResult } from '../engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 回测库路径：env `BACKTEST_DB_PATH` 优先，否则仓库根 `data/backtest.db` */
export function resolveBacktestDbPath(): string {
  return process.env.BACKTEST_DB_PATH ?? path.resolve(__dirname, '../../../../../../data/backtest.db');
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bt_run (
  run_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  params_json TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  initial_cash REAL NOT NULL,
  universe_mode TEXT NOT NULL,
  price_mode TEXT NOT NULL,
  benchmark_symbol TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  suspension_json TEXT NOT NULL,
  decision_tags_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bt_equity (
  run_id TEXT NOT NULL,
  date TEXT NOT NULL,
  equity REAL NOT NULL,
  cash REAL NOT NULL,
  risk_mv REAL NOT NULL,
  cash_mv REAL NOT NULL,
  benchmark_close REAL,
  /** 1 = 当日无基准 bar，benchmark_close 是沿用上一有效收盘（不参与 alpha/beta 成对统计） */
  benchmark_stale INTEGER NOT NULL DEFAULT 0,
  drawdown_ratio REAL NOT NULL,
  exposure REAL NOT NULL,
  PRIMARY KEY (run_id, date),
  FOREIGN KEY (run_id) REFERENCES bt_run(run_id)
);

CREATE TABLE IF NOT EXISTS bt_trade (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL,
  slippage_cost REAL NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id) REFERENCES bt_run(run_id)
);

CREATE TABLE IF NOT EXISTS bt_round_trip (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  open_date TEXT NOT NULL,
  close_date TEXT NOT NULL,
  qty REAL NOT NULL,
  pnl REAL NOT NULL,
  return_pct REAL NOT NULL,
  exit_reason TEXT NOT NULL,
  proceeds REAL NOT NULL,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id) REFERENCES bt_run(run_id)
);

CREATE TABLE IF NOT EXISTS bt_attribution (
  run_id TEXT NOT NULL,
  bucket_type TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  contribution_pct REAL NOT NULL,
  pnl REAL NOT NULL,
  trade_count INTEGER NOT NULL,
  detail_json TEXT,
  PRIMARY KEY (run_id, bucket_type, bucket_key),
  FOREIGN KEY (run_id) REFERENCES bt_run(run_id)
);

CREATE TABLE IF NOT EXISTS bt_trial (
  trial_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  param_json TEXT NOT NULL,
  score REAL,
  metrics_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES bt_run(run_id)
);

CREATE TABLE IF NOT EXISTS bt_metric (
  run_id TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  value_num REAL,
  value_json TEXT,
  PRIMARY KEY (run_id, metric_key),
  FOREIGN KEY (run_id) REFERENCES bt_run(run_id)
);

CREATE INDEX IF NOT EXISTS idx_bt_equity_run_date ON bt_equity(run_id, date);
CREATE INDEX IF NOT EXISTS idx_bt_trade_run_date ON bt_trade(run_id, date);
CREATE INDEX IF NOT EXISTS idx_bt_round_trip_run ON bt_round_trip(run_id);
`;

export interface WriteRunOptions {
  /** 默认 now（ISO） */
  startedAt?: string;
  /** 默认 now（ISO） */
  finishedAt?: string;
  /** 指定 run_id（默认 UUID） */
  runId?: string;
  /** M3 归因行（`bt_attribution`）；不传则只写前 5 张表 */
  attribution?: readonly AttributionRow[];
}

/**
 * 归因行（`bt_attribution` 的扁平形态）。
 *
 * 归因模块（`attribution/`）产出的报告在落库前拍平成这些行，避免 store 依赖归因内部类型。
 */
export interface AttributionRow {
  /** `symbol` / `round_trip_id` / `exit_reason` / `month` / `year` / `branch_tag` / `bucket` */
  bucketType: string;
  bucketKey: string;
  /** 该桶净额 PnL（元） */
  pnl: number;
  /** pnl / totalPnl（0~1；totalPnl 为 0 时记 0） */
  contributionPct: number;
  tradeCount: number;
  detail?: Record<string, unknown>;
}

/** 回测库句柄 */
export class BacktestStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = resolveBacktestDbPath()) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    // 既有库（M2 建的）没有 benchmark_stale：只加列 → ALTER TABLE ADD COLUMN（AGENTS.md DDL 判据）
    this.ensureColumn('bt_equity', 'benchmark_stale', 'INTEGER NOT NULL DEFAULT 0');
  }

  /** 幂等加列（`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效，故走 PRAGMA + ALTER） */
  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }

  /** 把一次回测结果整体写入（单事务；失败整体回滚，不留半拉子 run） */
  writeRun(result: BacktestResult, options: WriteRunOptions = {}): string {
    const runId = options.runId ?? randomUUID();
    const now = new Date().toISOString();
    const decisionTags: Record<string, unknown> = {};
    for (const d of result.decisions) {
      if (Object.keys(d.tags).length > 0) decisionTags[d.execDate] = d.tags;
    }

    const insertRun = this.db.prepare(
      `INSERT INTO bt_run (run_id, strategy_id, strategy_version, strategy_name, params_json,
         start_date, end_date, initial_cash, universe_mode, price_mode, benchmark_symbol,
         rules_json, suspension_json, decision_tags_json, status, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEquity = this.db.prepare(
      `INSERT INTO bt_equity (run_id, date, equity, cash, risk_mv, cash_mv, benchmark_close,
         benchmark_stale, drawdown_ratio, exposure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTrade = this.db.prepare(
      `INSERT INTO bt_trade (run_id, seq, date, symbol, side, qty, price, fee, slippage_cost, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertRoundTrip = this.db.prepare(
      `INSERT INTO bt_round_trip (run_id, seq, symbol, open_date, close_date, qty, pnl, return_pct,
         exit_reason, proceeds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMetric = this.db.prepare(
      `INSERT INTO bt_metric (run_id, metric_key, value_num, value_json) VALUES (?, ?, ?, ?)`,
    );
    const insertAttribution = this.db.prepare(
      `INSERT INTO bt_attribution (run_id, bucket_type, bucket_key, contribution_pct, pnl, trade_count,
         detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      const meta = result.meta;
      insertRun.run(
        runId,
        meta.strategyId,
        meta.strategyVersion,
        meta.strategyName,
        JSON.stringify(meta.params),
        result.equity[0]?.date ?? meta.start,
        result.equity[result.equity.length - 1]?.date ?? meta.end,
        meta.initialCash,
        meta.universeMode,
        meta.priceMode,
        meta.benchmarkSymbol,
        JSON.stringify(meta.rules),
        JSON.stringify(meta.suspension),
        JSON.stringify(decisionTags),
        'success',
        options.startedAt ?? now,
        options.finishedAt ?? now,
        now,
      );

      for (const p of result.equity) {
        insertEquity.run(
          runId,
          p.date,
          p.equity,
          p.cash,
          p.riskMv,
          p.cashMv,
          p.benchmarkClose,
          p.benchmarkStale === true ? 1 : 0,
          p.drawdownRatio,
          p.exposure,
        );
      }

      result.trades.forEach((t, i) => {
        insertTrade.run(runId, i, t.date, t.symbol, t.side, t.qty, t.price, t.fee, t.slippageCost, t.reason);
      });

      result.roundTrips.forEach((rt, i) => {
        insertRoundTrip.run(
          runId,
          i,
          rt.symbol,
          rt.openDate,
          rt.closeDate,
          rt.qty,
          rt.pnl,
          rt.returnPct,
          rt.exitReason,
          rt.proceeds,
        );
      });

      const m = result.metrics as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(m)) {
        if (typeof value === 'number') {
          insertMetric.run(runId, key, value, null);
        } else if (value !== null && value !== undefined) {
          insertMetric.run(runId, key, null, JSON.stringify(value));
        }
      }

      for (const row of options.attribution ?? []) {
        insertAttribution.run(
          runId,
          row.bucketType,
          row.bucketKey,
          row.contributionPct,
          row.pnl,
          row.tradeCount,
          row.detail ? JSON.stringify(row.detail) : null,
        );
      }
    });

    tx();
    return runId;
  }

  /** 查询某个 run 的净值行数（单测/自检用） */
  countRows(
    table: 'bt_run' | 'bt_equity' | 'bt_trade' | 'bt_round_trip' | 'bt_attribution' | 'bt_metric',
    runId?: string,
  ): number {
    const sql = runId
      ? `SELECT count(*) AS c FROM ${table} WHERE run_id = ?`
      : `SELECT count(*) AS c FROM ${table}`;
    const row = runId ? this.db.prepare(sql).get(runId) : this.db.prepare(sql).get();
    return Number((row as { c: number }).c);
  }
}
