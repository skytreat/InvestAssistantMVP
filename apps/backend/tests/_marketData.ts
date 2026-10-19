/**
 * 行情库可用性判定（CI / 本地行为一致性）
 *
 * 🔴 **背景（2026-10-19 实测）**：CI 环境**没有真实行情库** ——
 *   仓库里的 `data/quotes.duckdb` 只是 12KB 的**空壳**（无 `v_stock_qfq` 等表），
 *   而本地开发机指向 `/opt/invol/quotes.duckdb`（1.24GB 真实数据）。
 *   于是「依赖真实行情数据」的测试在**本地全绿、CI 全红**（PR #15 的后续 24 个
 *   commit 从未过 CI，就是这个原因）。
 *
 * ⚠️ **不能用 `fs.existsSync` 判定** —— CI 里那个空壳文件**是存在的**，
 *   但里面没有表 → 必须探测**表是否存在**。
 *
 * 用法（ESM 顶层 await，vitest 支持）：
 *   import { marketDataAvailable } from '../_marketData.js';
 *   const MARKET_DATA_AVAILABLE = await marketDataAvailable();
 *   it.skipIf(!MARKET_DATA_AVAILABLE)('需要真实行情库', () => { ... });
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 判定用��表（真实行情库的标志） */
const PROBE_TABLE = 'v_stock_qfq';

/**
 * 真实行情库是否可用（含 `v_stock_qfq` 表）
 *
 * 判定过程：
 *   1. 文件存在？   → 否则 false
 *   2. 能打开？     → 否则 false
 *   3. 有 `v_stock_qfq` 表？ → 否则 false
 *
 * ⚠️ **打开时必须 `readOnly: true`** —— DuckDB 的文件锁是排他的，
 *   以读写方式打开会与后端进程抢锁。
 */
export async function detectMarketDataAvailable(): Promise<boolean> {
  const dbPath = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
  if (!dbPath || !fs.existsSync(dbPath)) return false;
  try {
    const { DuckDBInstance } = require('@duckdb/node-api');
    // ⚠️ `connect()` 是**异步**的（返回 Promise）—— 少 await 会拿到 Promise，
    //    后面 `.runAndReadAll` 不存在 → 被 catch 吞掉 → 误判为「无行情库」。
    const inst = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
    try {
      const conn = await inst.connect();
      try {
        // ⚠️ `runAndReadAll()` 也是**异步**的 —— 少 await 会拿到 Promise，
        //    `.getRows` 不存在 → 被 catch 吞掉 → 误判为「无行情库」。
        const res = await conn.runAndReadAll(
          `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_name = '${PROBE_TABLE}'`,
        );
        const rows = res.getRows();
        return rows.length > 0 && Number(rows[0][0]) > 0;
      } finally {
        conn.closeSync();
      }
    } finally {
      inst.closeSync();
    }
  } catch {
    return false;
  }
}

/**
 * 真实行情库是否可用
 *
 * ⚠️ **同步判定**：`@duckdb/node-api` 的 `connect()` 是异步的，顶层 await 在
 *   CommonJS 转换下不稳 → 这里用 `createRequire` 同步加载 DuckDB 的**同步** API
 *   不可行（该库只有异步 API）。
 *   → 折中：用一个**同步的探测**（读文件头判断是否含 `v_stock_qfq` 的表定义太脆弱），
 *     改为在**测试文件顶层 await** 时显式等待 —— 故这里导出函数 + 一个惰性缓存。
 */
let _cached: boolean | null = null;

/** 真实行情库是否可用（首次调用时判定并缓存） */
export async function marketDataAvailable(): Promise<boolean> {
  if (_cached === null) _cached = await detectMarketDataAvailable();
  return _cached;
}

/** 统一的跳过原因文案（便于 CI 日志里看懂为什么少跑了用例） */
export const SKIP_REASON_NO_MARKET_DATA =
  '需要真实行情库（v_stock_qfq 表）；CI 环境只有 12KB 空壳，无行情数据';
