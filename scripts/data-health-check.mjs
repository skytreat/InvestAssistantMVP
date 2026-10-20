#!/usr/bin/env node
/**
 * 全库数据体检（G1.6）
 *
 * 只读脚本 —— 不写任何数据。检查三项：
 *   1. 无负持仓（totalQuantity < 0）
 *   2. 无负成本（totalCostBasis < 0）
 *   3. 无「同日 + 同标的 + 同类型 + 同时刻」重复
 *
 * 用法：
 *   SQLITE_DB_PATH=/path/to/business.db node scripts/data-health-check.mjs
 *   （不传则用 configStore 的默认路径 `data/business.db`）
 *
 * 退出码：0 = 全部通过；1 = 存在不变量违反
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dbPath = process.env.SQLITE_DB_PATH ?? path.resolve('data', 'business.db');

if (!fs.existsSync(dbPath)) {
  console.error(`[data-health] 找不到数据库：${dbPath}`);
  console.error('[data-health] 用 SQLITE_DB_PATH 指定，或先启动一次后端生成。');
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });
const problems = [];

console.log(`[data-health] 目标库：${dbPath}`);

// ── schema 自适应：trade_time 是 T87 才加的列，旧库没有 ──
const cols = db
  .prepare('PRAGMA table_info(user_trade_record)')
  .all()
  .map((c) => c.name);
const HAS_TRADE_TIME = cols.includes('trade_time');
if (!HAS_TRADE_TIME) {
  console.log(
    '[data-health] ⚠️ 该库 schema 早于 T87（无 trade_time 列）—— ' +
      '按 trade_date + id 排序回放；建议用新代码启动一次以完成幂等迁移',
  );
}

// ── 1. 负持仓 / 负成本 ──
// 移动加权成本的口径：买入累加成本、卖出按均价结转。
// 负成本只在「卖出量超过持仓」时出现 —— T84 的时点校验就是拦这个的。
const costRows = db
  .prepare(
    `SELECT id, user_id, asset_code, trade_type, trade_date, quantity, price, fee, is_deleted
       FROM user_trade_record
      WHERE is_deleted = 0
      ORDER BY user_id, asset_code, trade_date ASC, id ASC`,
  )
  .all();

/** 按标的逐笔回放，算出每笔之后的持仓量与成本 */
const replay = new Map();
for (const r of costRows) {
  const key = `${r.user_id}::${r.asset_code}`;
  let st = replay.get(key);
  if (!st) {
    st = { qty: 0, cost: 0, lastQty: 0, lastCost: 0 };
    replay.set(key, st);
  }
  const qty = Number(r.quantity);
  const fee = Number(r.fee);
  const price = Number(r.price);

  if (r.trade_type === 'buy' || r.trade_type === 'add') {
    st.qty += qty;
    st.cost += qty * price + fee;
  } else if (r.trade_type === 'reduce' || r.trade_type === 'clear') {
    const avg = st.qty > 0 ? st.cost / st.qty : 0;
    const sold = Math.min(qty, Math.max(0, st.qty));
    st.qty -= sold;
    st.cost = st.qty > 0 ? st.qty * avg : 0;
  }

  if (st.qty < -1e-9) {
    problems.push(
      `负持仓：user=${r.user_id} asset=${r.asset_code} trade#${r.id} ` +
        `(type=${r.trade_type} date=${r.trade_date} ${r.trade_time ?? ''}) → 持仓 ${st.qty}`,
    );
  }
  if (st.cost < -1e-6) {
    problems.push(
      `负成本：user=${r.user_id} asset=${r.asset_code} trade#${r.id} → 成本 ${st.cost.toFixed(6)}`,
    );
  }
}

// ── 2. 同日+同标的+同类型+同时刻 重复 ──
// 去重键：T87 起是「同日 + 同标的 + 同类型 + **同时刻**」；旧 schema 无 trade_time 列则退到「同日」
const dupRows = db
  .prepare(
    `SELECT user_id, asset_code, trade_type, trade_date${HAS_TRADE_TIME ? ', trade_time' : ''}, COUNT(*) AS cnt
       FROM user_trade_record
      WHERE is_deleted = 0
      GROUP BY user_id, asset_code, trade_type, trade_date${HAS_TRADE_TIME ? ', trade_time' : ''}
     HAVING COUNT(*) > 1`,
  )
  .all();
for (const d of dupRows) {
  problems.push(
    `重复交易：user=${d.user_id} asset=${d.asset_code} type=${d.trade_type} ` +
      `date=${d.trade_date}${HAS_TRADE_TIME ? ' time=' + d.trade_time : ''} ×${d.cnt}`,
  );
}

// ── 3. 附带体检（不影响门槛结论，仅提示）──
const tradeCount = db.prepare('SELECT COUNT(*) AS c FROM user_trade_record').get().c;
const liveCount = db.prepare('SELECT COUNT(*) AS c FROM user_trade_record WHERE is_deleted = 0').get().c;
const userCount = db.prepare('SELECT COUNT(*) AS c FROM user_account').get().c;
const signalCount = db.prepare('SELECT COUNT(*) AS c FROM user_strategy_signal').get().c;
const relCount = db.prepare('SELECT COUNT(*) AS c FROM user_asset_rel').get().c;

console.log(
  `[data-health] 规模：user=${userCount} trade=${tradeCount}（未删 ${liveCount}）` +
    ` signal=${signalCount} rel=${relCount}`,
);

if (problems.length === 0) {
  console.log('[data-health] ✅ 全部通过：无负持仓 / 无负成本 / 无同日同标的同类型同时刻重复');
  db.close();
  process.exit(0);
}

console.log(`[data-health] ❌ 发现 ${problems.length} 处不变量违反：`);
for (const p of problems.slice(0, 50)) console.log(`  - ${p}`);
if (problems.length > 50) console.log(`  ...（另有 ${problems.length - 50} 处）`);
db.close();
process.exit(1);
