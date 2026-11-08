/**
 * 纸面账户 DB 门面（PA-05）
 *
 * 与回测**共享同一个 SQLite 文件**（D1：`data/backtest.db`），但连接独立：
 *   - 打开即 `createPaperSchema()`（建表 + 立刻跑 §13.4 隔离校验）；
 *   - 播种系统默认费用配置（回退链第 ③ 层，幂等）；
 *   - 只做纸面读写；回测侧 `BacktestStore` 的行为完全不变。
 *
 * 惰性单例：路径在首次 `getInstance()` 时解析（`BACKTEST_DB_PATH` 供测试覆盖），
 * 不在模块顶层读 env（`--coverage` 会提前求值模块，见 AGENTS.md CI 陷阱 2）。
 */
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { resolveBacktestDbPath } from '../backtest/store/backtestDb.js';
import { createPaperSchema } from '../backtest/store/paperSchema.js';
import { ensureSystemDefaultFeeConfig } from './fees.js';

export class PaperStore {
  private static _instance: PaperStore | null = null;
  private _db: Database.Database | null = null;
  readonly dbPath: string;

  constructor(dbPath: string = resolveBacktestDbPath()) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    createPaperSchema(db);
    ensureSystemDefaultFeeConfig(db);
    this._db = db;
  }

  get db(): Database.Database {
    if (!this._db) throw new Error('PaperStore 已关闭');
    return this._db;
  }

  static getInstance(): PaperStore {
    if (!PaperStore._instance) PaperStore._instance = new PaperStore();
    return PaperStore._instance;
  }

  /** 测试专用：关闭并丢弃单例，下一次 `getInstance()` 重新解析路径 */
  static resetInstance(): void {
    if (PaperStore._instance) {
      PaperStore._instance.close();
      PaperStore._instance = null;
    }
  }

  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}
