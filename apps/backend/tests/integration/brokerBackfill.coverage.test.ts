/**
 * T119 券商补录事件覆盖 —— 端到端（导入 → 补录 → 查询）
 *
 * 背景：旧实现只补录 TRADE_BUY/TRADE_SELL，`TRANSFER_IN` / `DIVIDEND_BONUS` /
 * `DIVIDEND_CASH` 全部滞留在事实层 ⇒ 业务层缺失转增/送股 ⇒ 回放起点持仓被低估
 * ⇒ 16 笔「假超卖」（卖出量 > 当时可用持仓），复盘已实现盈亏被高估。
 *
 * 本用例用 `tests/fixtures/broker-samples/20261020_华宝成交.xls`（与 owner 真实
 * 成交单事件分布一致：671 行 / 成交族 275 行 / 红利 10 行 / 送股 1 行 / 调帐转入 4 行）
 * 跑完整链路，断言：
 *   - 业务层记录数、fee 合计、红利/送股/转增行齐全
 *   - 复盘封顶后不存在任何被截断的卖出（4 只 LOF 的空仓卖出除外 —— 场外申购按
 *     Requirements §3.1 / INV-S3-5 **不进业务层**，仍为空仓卖出）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// mock DuckDB raw_symbol_class（存在性判定源）
const { queryDuckDBMock } = vi.hoisted(() => ({
  queryDuckDBMock: vi.fn(async (_sql: string, _params?: unknown[]) => [] as Array<{ symbol: string }>),
}));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';
import { parseBrokerFile } from '../../src/services/broker/brokerParser.js';
import { normalizeBrokerRow } from '../../src/services/broker/brokerImport.js';
import { shouldPromote } from '../../src/services/broker/brokerConfirm.js';
import { calcClosedTradePnLs } from '../../src/services/positionCalculator.js';

let bundle: TestAppBundle;
const FIX = path.resolve(__dirname, '../../../../tests/fixtures/broker-samples');
const FILE = '20261020_华宝成交.xls';
const BROKER = '华宝';

/** 场外申购标的（Requirements §3.1 / INV-S3-5：不进业务层 ⇒ 修复后仍是空仓卖出） */
const LOF_CODES = ['sz160723', 'sz160416', 'sz162411', 'sz162719'];

interface FactRow {
  id: number;
  event_type: string;
  asset_code: string | null;
  price: number | null;
  quantity: number | null;
  cash_flow: number | null;
  fee_total: number | null;
  match_status: string;
}

interface TradeRow {
  id: number;
  asset_code: string;
  trade_type: string;
  quantity: number;
  price: number;
  fee: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function filePayload(name: string) {
  const buffer = fs.readFileSync(path.join(FIX, name));
  return { filename: name, fileBase64: buffer.toString('base64') };
}

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

describe('T119 补录事件覆盖 · 导入 → 补录 → 查询', () => {
  it('华宝成交单：fee 合计 1748.02、红利 387.40、送股 60 股、转增 105900 股，封顶后无假超卖', async () => {
    // ① 解析 fixture，取得全部标的码 → 行情层 mock 全放行（避免「标的不存在」挡住补录）
    const buffer = fs.readFileSync(path.join(FIX, FILE));
    const parse = await parseBrokerFile({ buffer, filename: FILE });
    expect(parse.ok).toBe(true);
    const codes = [
      ...new Set(
        parse.rows
          .map((row) => normalizeBrokerRow(parse, row).asset_code)
          .filter((c): c is string => typeof c === 'string' && c.length > 0),
      ),
    ];
    expect(codes.length).toBeGreaterThan(0);
    queryDuckDBMock.mockResolvedValue(codes.map((symbol) => ({ symbol })));

    // ② 导入（只写事实层，不写业务层）
    const imported = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/confirm-final',
      headers: authHeaders(),
      payload: { brokerCode: BROKER, files: [filePayload(FILE)] },
    });
    expect(imported.statusCode).toBe(200);

    const facts = bundle.db.db
      .prepare(
        `SELECT id, event_type, asset_code, price, quantity, cash_flow, fee_total, match_status
           FROM broker_trade_record
          WHERE user_id = ? AND is_deleted = 0`,
      )
      .all(bundle.userId) as FactRow[];
    expect(facts.length).toBeGreaterThan(600); // 671 行原始事实

    const confirmable = facts.filter((f) => f.match_status !== 'EXCLUDED' && shouldPromote(f.event_type));
    expect(confirmable.length).toBe(290); // 275 成交族 + 4 转入 + 10 红利 + 1 送股

    // ③ 补录（一次确认，系统推导类型）
    const confirmed = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-reconcile/confirm',
      headers: authHeaders(),
      payload: { brokerCode: BROKER, items: confirmable.map((f) => ({ sourceId: f.id })) },
    });
    expect(confirmed.statusCode).toBe(200);
    const body = JSON.parse(confirmed.body) as {
      data: { imported: number; invalid: number; already: number };
    };
    expect(body.data.imported).toBe(290);
    expect(body.data.invalid).toBe(0);
    expect(body.data.already).toBe(0);

    // ④ 查询业务层
    const trades = bundle.db.db
      .prepare(
        `SELECT id, asset_code, trade_type, quantity, price, fee
           FROM user_trade_record
          WHERE user_id = ? AND is_deleted = 0`,
      )
      .all(bundle.userId) as TradeRow[];
    expect(trades.length).toBe(290);

    // 费用：佣金 745.62 + 印花税 978.79 + 过户费 23.61（成交族 275 行）
    const feeTotal = r2(trades.reduce((s, t) => s + t.fee, 0));
    expect(feeTotal).toBe(1748.02);
    const feeFromFacts = r2(
      confirmable
        .filter((f) => f.event_type === 'TRADE_BUY' || f.event_type === 'TRADE_SELL')
        .reduce((s, f) => s + (f.fee_total ?? 0), 0),
    );
    expect(feeFromFacts).toBe(1748.02);

    // 红利：10 笔，业务层 price×quantity 合计 = 387.40（「实际口径」据此加回分红）
    const dividends = trades.filter((t) => t.trade_type === 'dividend');
    expect(dividends.length).toBe(10);
    expect(r2(dividends.reduce((s, t) => s + t.price * t.quantity, 0))).toBeCloseTo(387.4, 2);

    // 送股：1 笔 60 股，price=0（成本基不变）
    const bonuses = trades.filter((t) => t.trade_type === 'bonus');
    expect(bonuses.length).toBe(1);
    expect(bonuses[0].quantity).toBe(60);
    expect(bonuses[0].price).toBe(0);

    // 调帐转入：4 笔合计 105,900 股（515880 41000 / 159516 9300+34900 / 159995 20700）
    const transfers = trades.filter((t) => t.trade_type === 'transfer');
    expect(transfers.length).toBe(4);
    expect(transfers.reduce((s, t) => s + t.quantity, 0)).toBe(105900);
    expect(new Set(transfers.map((t) => t.asset_code))).toEqual(
      new Set(['sh515880', 'sz159516', 'sz159995']),
    );

    // ⑤ 复盘封顶口径：不再出现「卖出被截断」（= 假超卖）
    const pnls = calcClosedTradePnLs(bundle.userId);
    expect(pnls.length).toBeGreaterThan(0);
    const tradeById = new Map(trades.map((t) => [t.id, t]));
    // ⚠️ ClosedTradePnl 声明的是 trade_id，但实现是 `{ ...row }` 展开（运行时字段是 id）
    const idOf = (p: { id?: number; trade_id?: number }) => p.id ?? p.trade_id ?? -1;
    const truncated = pnls.filter((p) => p.quantity !== (tradeById.get(idOf(p))?.quantity ?? -1));
    expect(
      truncated.slice(0, 20).map((p) => ({
        code: p.asset_code,
        date: p.trade_date,
        qty: p.quantity,
        orig: tradeById.get(idOf(p))?.quantity ?? -1,
      })),
    ).toEqual([]);

    // ⑥ 4 只 LOF 例外：场外申购按 INV-S3-5 不进业务层 ⇒ 仍为空仓卖出（不计入「超卖清零」）
    const lofTrades = trades.filter((t) => LOF_CODES.includes(t.asset_code));
    expect(lofTrades.length).toBe(4);
    expect(lofTrades.every((t) => t.trade_type === 'reduce' || t.trade_type === 'clear')).toBe(true);
    expect(pnls.filter((p) => LOF_CODES.includes(p.asset_code))).toEqual([]);
  });
});
