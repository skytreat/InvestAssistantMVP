/**
 * trade.test.ts — API 集成测试（交易 + 持仓链路）
 *
 * 覆盖 SDD §12.4 trade 类：
 *   - buy 201 + 返回 position
 *   - GET /api/trade 过滤 asset_code
 *   - sell 超持仓 → 400 HOLDING_INSUFFICIENT
 *   - sell 恰好持仓 → 201 + position.qty=0
 *   - duplicate trade (同日同标的同方向) → 409
 *   - quantity<=0 / price<0 → 400
 *   - 非法 trade_type → 400
 *   - **交易类型白名单 ≡ DDL CHECK（7 种）**：add（加仓）→ 201、sell → 400 PARAM_INVALID
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
const TRADE_CODE = 'szTEST01';
const TRADE_DATE = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  bundle = await createTestApp();
  // 清残留（之前跑过可能留下）
  bundle.db.db
    .prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?')
    .run(bundle.userId, TRADE_CODE);
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

/**
 * 🔴 T81 顺序依赖修复：本文件原先三个 describe 共享 `szTEST01` 的持仓状态
 *   （describe 1 买入 → describe 2 卖出）。T81 的 `sequence.shuffle` 一开，
 *   「GET 列表」可能先于「买入」跑（0 行），「卖出恰好 100 股」可能先于建仓跑（409）。
 *   （实测：shuffle 关 → 全绿；shuffle 开 → 2 个用例红。）
 *   → 改为**每个用例用独立标的并自建仓**。
 */
async function seedBuy(assetCode: string, quantity = 100, price = 10.0, fee = 5): Promise<void> {
  bundle.db.db
    .prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?')
    .run(bundle.userId, assetCode);
  const res = await bundle.app.inject({
    method: 'POST',
    url: '/api/trade',
    headers: authHeaders(),
    payload: {
      asset_code: assetCode,
      trade_type: 'buy',
      trade_date: TRADE_DATE,
      trade_time: '09:00:01',
      quantity,
      price,
      fee,
      trade_reason: '集成测试建仓',
    },
  });
  expect(res.statusCode, '建仓应成功').toBe(201);
}

describe('Trade · 买入 + 持仓查询', () => {
  it('买入 100 股 @ 10.0 → 201', async () => {
    const CODE = 'szTEST01';
    await seedBuy(CODE);
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body).data;
    const mine = rows.find((r: any) => r.asset_code === CODE && r.trade_date === TRADE_DATE);
    expect(mine, '买入应落库').toBeDefined();
    expect(mine.trade_type).toBe('buy');
    expect(Number(mine.quantity)).toBe(100);
  });

  it('GET /api/trade → 列表有刚录的那条', async () => {
    const CODE = 'szTEST11';
    await seedBuy(CODE);
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body).data;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const mine = rows.find((r: any) => r.asset_code === CODE && r.trade_date === TRADE_DATE);
    expect(mine).toBeDefined();
  });

  it('GET /api/holding/:asset_code → qty=100', async () => {
    const CODE = 'szTEST12';
    await seedBuy(CODE);
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/holding/${CODE}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalQuantity).toBe(100);
    // 均价含手续费：(1000+5)/100 = 10.05
    expect(body.data.avgCost).toBeCloseTo(10.05, 4);
  });
});

describe('Trade · HOLDING_INSUFFICIENT', () => {
  it('卖出超过持仓 → 409 HOLDING_INSUFFICIENT', async () => {
    const CODE = 'szTEST21';
    await seedBuy(CODE, 100, 10.0, 5);
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: CODE,
        trade_type: 'reduce',
        trade_date: TRADE_DATE,
        trade_time: '09:00:02',
        quantity: 999,
        price: 11.0,
        trade_reason: '测试卖出超持仓',
      },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('HOLDING_INSUFFICIENT');
    expect(body.error).toBe('HOLDING_INSUFFICIENT');
    expect('success' in body).toBe(false);
  });

  it('卖出恰好 100 股 → 201 + position=0', async () => {
    const CODE = 'szTEST22';
    await seedBuy(CODE, 100, 10.0, 5);
    const sellDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10); // 次日避免 UNIQUE
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: CODE,
        trade_type: 'reduce',
        trade_date: sellDate,
        trade_time: '09:00:03',
        quantity: 100,
        price: 11.0,
        trade_reason: '测试清仓卖出',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.position.totalQuantity).toBe(0);
    expect(body.data.position.realizedPnL).toBeGreaterThan(0); // 赚了（realizedPnL 大写 L）
  });
});

describe('Trade · 参数校验', () => {
  it('quantity=0 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE_CODE,
        trade_type: 'buy',
        trade_date: TRADE_DATE,
        trade_time: '09:00:04',
        quantity: 0,
        price: 10,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('quantity<0 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE_CODE,
        trade_type: 'buy',
        trade_date: TRADE_DATE,
        trade_time: '09:00:05',
        quantity: -1,
        price: 10,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('price<0 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE_CODE,
        trade_type: 'buy',
        trade_date: TRADE_DATE,
        trade_time: '09:00:06',
        quantity: 10,
        price: -1,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('缺 asset_code → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: { trade_type: 'buy', trade_date: TRADE_DATE, trade_time: '09:00:07', quantity: 10, price: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非法 trade_type → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE_CODE,
        trade_type: 'fly',
        trade_date: TRADE_DATE,
        trade_time: '09:00:08',
        quantity: 10,
        price: 10,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('duplicate（同日同标的同方向）→ 409 TRADE_DUPLICATE', async () => {
    // 先清一次（前一组测完持仓=0，这次新开）
    const TRADE2 = 'szTEST02';
    const BUY_DATE = new Date().toISOString().slice(0, 10);
    bundle.db.db
      .prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?')
      .run(bundle.userId, TRADE2);

    await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE2,
        trade_type: 'buy',
        trade_date: BUY_DATE,
        trade_time: '09:00:09',
        quantity: 10,
        price: 10,
        trade_reason: 'dup1',
      },
    });
    // T87：同日同标的同类型、**不同成交时间** → 201 追加成功（B-11 裁决：同日分笔可追加）
    const appended = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE2,
        trade_type: 'buy',
        trade_date: BUY_DATE,
        trade_time: '09:00:10',
        quantity: 20,
        price: 11,
        trade_reason: 'dup2',
      },
    });
    expect(appended.statusCode).toBe(201);

    // T87：**相同**成交时间才算重复 → 409 TRADE_DUPLICATE
    const dup = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE2,
        trade_type: 'buy',
        trade_date: BUY_DATE,
        trade_time: '09:00:10',
        quantity: 30,
        price: 12,
        trade_reason: 'dup3',
      },
    });
    expect(dup.statusCode).toBe(409);
    const body = JSON.parse(dup.body);
    expect(body.error).toBe('TRADE_DUPLICATE');
  });
});

/**
 * 🔴 交易类型白名单（本次 bug 的修复面）
 *
 * 修复前白名单 = `['buy','sell','reduce','clear','dividend','bonus','transfer']`：
 *   - `'sell'` 不在 DDL CHECK 内 → INSERT 撞约束 → **500 + 裸 SQLite 报错外泄**
 *   - `'add'`（前端「加仓」）不在白名单内 → **400 PARAM_INVALID**（线上入口是坏的）
 *
 * 修复后白名单 = DDL CHECK = Requirements §5.1 的 7 种：
 *   `['buy','add','reduce','clear','dividend','bonus','transfer']`
 */
describe('Trade · 交易类型白名单（≡ DDL CHECK）', () => {
  const DDL_TYPES = ['buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer'];

  async function postTrade(payload: Record<string, unknown>) {
    return bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        trade_date: TRADE_DATE,
        trade_time: '10:00:00',
        quantity: 10,
        price: 10,
        ...payload,
      },
    });
  }

  it("'add'（加仓）→ 201，且持仓数量增加、均价按移动加权成本重算", async () => {
    const CODE = 'szTYPE01';
    // 建仓 100@10，手续费 5 → 成本 1005，持仓 100，均价 10.05
    await seedBuy(CODE, 100, 10.0, 5);
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'add',
      trade_time: '10:00:01',
      quantity: 100,
      price: 12.0,
      fee: 5,
      trade_reason: '加仓测试',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // 加仓后：数量 100 → 200；均价 (100*10+5 + 100*12+5)/200 = 11.05
    expect(body.data.position.totalQuantity).toBe(200);
    expect(body.data.position.avgCost).toBeCloseTo(11.05, 6);
    expect(body.data.position.totalCostBasis).toBeCloseTo(2210, 6);
  });

  it("'add' 缺 trade_reason → 400 TRADE_REASON_REQUIRED（Requirements §5.2）", async () => {
    const CODE = 'szTYPE02';
    await seedBuy(CODE, 100, 10.0, 5);
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'add',
      trade_time: '10:00:02',
      quantity: 10,
      price: 12.0,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('TRADE_REASON_REQUIRED');
  });

  it("'sell' → 400 PARAM_INVALID（DDL 不认；不 500、不落库、不外泄 SQLite 报错）", async () => {
    const CODE = 'szTYPE03';
    await seedBuy(CODE, 100, 10.0, 5);
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'sell',
      trade_time: '10:00:03',
      quantity: 10,
      price: 11.0,
      trade_reason: '老客户端发 sell',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('PARAM_INVALID');
    // 文案须给出替代类型指引（部分卖出=reduce，全部卖出=clear）
    expect(body.message).toContain('reduce');
    expect(body.message).toContain('clear');
    // 不得外泄底层 SQLite 报错
    expect(res.body).not.toMatch(/CHECK constraint failed/i);
    expect(res.body).not.toMatch(/SQLITE_CONSTRAINT/i);

    // 未落库
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}`,
      headers: authHeaders(),
    });
    const rows = JSON.parse(list.body).data as any[];
    expect(
      rows.some((r) => r.trade_type === 'sell'),
      'sell 不得落库',
    ).toBe(false);
  });

  it("'foo'（非法类型）→ 400 PARAM_INVALID", async () => {
    const res = await postTrade({
      asset_code: 'szTYPE04',
      trade_type: 'foo',
      trade_time: '10:00:04',
      trade_reason: '非法类型',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('PARAM_INVALID');
  });

  it('7 种类型逐个被接受（buy/add/reduce/clear/dividend/bonus/transfer）', async () => {
    // 每个类型用独立标的，避免 UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time) 互撞
    const sellTypes = ['reduce', 'clear'];
    for (const type of DDL_TYPES) {
      const CODE = `szT7${type}`;
      // 卖出类需要先有持仓
      if (sellTypes.includes(type)) {
        await seedBuy(CODE, 100, 10.0, 0);
      }
      const res = await postTrade({
        asset_code: CODE,
        trade_type: type,
        trade_time: '10:01:00',
        quantity: type === 'clear' ? 100 : 10,
        price: type === 'dividend' ? 0.5 : 10,
        // 买入/加仓/减仓/清仓必须给理由；分红/送股/转增由系统固化
        trade_reason:
          sellTypes.includes(type) || type === 'buy' || type === 'add' ? `测试${type}` : undefined,
      });
      expect(res.statusCode, `类型 ${type} 应被接受`).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.trade_id).toBeGreaterThan(0);
      expect(body.data.position).toBeDefined();
    }
  });

  it('加仓后 GET /api/trade 能查到 trade_type=add 的记录', async () => {
    const CODE = 'szTYPE05';
    await seedBuy(CODE, 100, 10.0, 0);
    await postTrade({
      asset_code: CODE,
      trade_type: 'add',
      trade_time: '10:02:00',
      quantity: 50,
      price: 11,
      trade_reason: '加仓落库校验',
    });
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}&trade_type=add`,
      headers: authHeaders(),
    });
    const rows = JSON.parse(list.body).data as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].trade_type).toBe('add');
    expect(Number(rows[0].quantity)).toBe(50);
  });
});

/**
 * 🔴 SDD §12.5 F2 用例：`create_trade_all_types`
 *
 * ## ⚠️ SDD §12.5 F2 的描述**有误**（已登记为偏差，不擅自改 SDD）
 *
 * SDD §12.5 F2 原文写的是「买入/卖出/送转/派息/配股/增发/拆股」——
 * 与**实际实现的 7 种完全对不上**（`sell` 已被 DEC-2 移除，`add` 反而是合法类型）。
 *
 * 实际 7 种（Requirements §5.1 + DDL CHECK + `routes/trade.ts` 的 `TRADE_TYPES` 三方一致）：
 *
 * | trade_type | 中文   | 触发方式         | 操作理由                     |
 * |------------|--------|------------------|------------------------------|
 * | `buy`      | 买入   | 用户手动         | **用户填写**（必填）         |
 * | `add`      | 加仓   | 用户手动         | **用户填写**（必填）         |
 * | `reduce`   | 减仓   | 用户手动         | **用户填写**（必填）         |
 * | `clear`    | 清仓   | 用户手动         | **用户填写**（必填）         |
 * | `dividend` | 分红   | 系统导入 / 人工补| **系统固化**                 |
 * | `bonus`    | 送股   | 系统导入 / 人工补| **系统固化**                 |
 * | `transfer` | 转增   | 系统导入 / 人工补| **系统固化**                 |
 *
 * ## 本用例覆盖的硬约束
 *
 * - `trade_time` **必填**（T87）且与「同日同标的同类型」构成**部分唯一索引** ⇒
 *   7 种类型必须用**各自不同的 trade_time**（否则撞 UNIQUE → 409 TRADE_DUPLICATE）。
 * - `reduce` / `clear` 必须**先有持仓**（否则 409 HOLDING_INSUFFICIENT）⇒ 先造一笔 `buy` 底仓。
 * - `buy` / `add` / `reduce` / `clear` 缺 `trade_reason` ⇒ 400 TRADE_REASON_REQUIRED。
 * - `dividend` / `bonus` / `transfer` 不传 `trade_reason` ⇒ 理由由**后端固化**。
 *
 * ## ⚠️ 理由前缀的**已知口径偏差**（取证用，不擅自改实现）
 *
 * Requirements §5.2 规定「分红/送股/转增（用户手动补充）」的理由格式为
 * 「**人工补充** - {除权日} {类型}」，而 `routes/trade.ts:279` 的后端兜底固化文案是
 * 「**自动导入** - {日期} {trade_type}」。
 * 本用例断言的是**实测行为**（后端兜底分支），并另加一条用例覆盖前端实际会传的
 * 「人工补充 - ...」文案（客户端显式传理由时后端原样保留）。
 */
describe('Trade · create_trade_all_types（SDD §12.5 F2：7 种交易类型逐一可写）', () => {
  /** 7 种类型的用例表：每种一个独立标的 + 独立成交时刻（避开部分唯一索引） */
  const G5_TYPES = [
    {
      type: 'buy',
      label: '买入',
      code: 'szG5BUY',
      tradeTime: '10:01:01',
      quantity: 100,
      price: 10,
      fee: 5,
      seed: false,
      reason: 'G5 建仓',
      /** 动作后的持仓数量（当前实现口径） */
      expectQty: 100,
    },
    {
      type: 'add',
      label: '加仓',
      code: 'szG5ADD',
      tradeTime: '10:01:02',
      quantity: 100,
      price: 12,
      fee: 5,
      seed: true,
      reason: 'G5 加仓',
      expectQty: 200,
    },
    {
      type: 'reduce',
      label: '减仓',
      code: 'szG5RED',
      tradeTime: '10:01:03',
      quantity: 30,
      price: 11,
      fee: 2,
      seed: true,
      reason: 'G5 减仓',
      expectQty: 70,
    },
    {
      type: 'clear',
      label: '清仓',
      code: 'szG5CLR',
      tradeTime: '10:01:04',
      quantity: 100,
      price: 11,
      fee: 2,
      seed: true,
      reason: 'G5 清仓',
      expectQty: 0,
    },
    {
      type: 'dividend',
      label: '分红',
      code: 'szG5DIV',
      tradeTime: '10:01:05',
      quantity: 100,
      price: 0.5,
      fee: 0,
      seed: true,
      reason: null,
      /** 分红**不改变**持仓数量与成本（Requirements §5.3） */
      expectQty: 100,
    },
    {
      type: 'bonus',
      label: '送股',
      code: 'szG5BON',
      tradeTime: '10:01:06',
      quantity: 10,
      price: 0,
      fee: 0,
      seed: true,
      reason: null,
      // T119（V3.0）：送股计入移动加权（股数 +n、均价摊薄，SDD_v3 §8.5）⇒ 100 + 10 = 110
      expectQty: 110,
    },
    {
      type: 'transfer',
      label: '转增',
      code: 'szG5TRF',
      tradeTime: '10:01:07',
      quantity: 10,
      price: 0,
      fee: 0,
      seed: true,
      reason: null,
      // transfer（转托管）仍**不参与**移动加权（mapToCoreTrade 过滤，转托管不改总持仓/成本）⇒ 100
      expectQty: 100,
    },
  ] as const;

  /** 清掉某标的的历史记录（每个用例独立，避免 UNIQUE / 持仓状态互撞） */
  function wipeAsset(code: string): void {
    bundle.db.db
      .prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?')
      .run(bundle.userId, code);
  }

  /** 造一笔 `buy` 底仓（供 加仓 / 减仓 / 清仓 / 分红 / 送股 / 转增 用） */
  async function seedHolding(code: string, quantity = 100, price = 10): Promise<void> {
    wipeAsset(code);
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: code,
        trade_type: 'buy',
        trade_date: TRADE_DATE,
        trade_time: '10:00:00',
        quantity,
        price,
        fee: 0,
        trade_reason: 'G5 建底仓',
      },
    });
    expect(res.statusCode, `${code} 建底仓应成功`).toBe(201);
  }

  /** POST /api/trade 后按 asset_code + trade_type（可选再按成交时刻）把落库记录查回来 */
  async function fetchRow(code: string, tradeType: string, tradeTime?: string): Promise<any> {
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${code}&trade_type=${tradeType}`,
      headers: authHeaders(),
    });
    expect(list.statusCode).toBe(200);
    const rows = JSON.parse(list.body).data as any[];
    const matched = rows.filter((r) => r.trade_type === tradeType);
    return tradeTime === undefined ? matched[0] : matched.find((r) => r.trade_time === tradeTime);
  }

  it('create_trade_all_types: 7 种类型逐一创建成功（201 + 载荷正确 + 落库可查回）', async () => {
    for (const c of G5_TYPES) {
      if (c.seed) {
        await seedHolding(c.code, 100, 10);
      } else {
        wipeAsset(c.code);
      }

      const payload: Record<string, unknown> = {
        asset_code: c.code,
        trade_type: c.type,
        trade_date: TRADE_DATE,
        trade_time: c.tradeTime,
        quantity: c.quantity,
        price: c.price,
        fee: c.fee,
      };
      // 买入类必须给理由；分红/送股/转增**不给**理由 ⇒ 走系统固化分支
      if (c.reason) payload.trade_reason = c.reason;

      const res = await bundle.app.inject({
        method: 'POST',
        url: '/api/trade',
        headers: authHeaders(),
        payload,
      });

      // ① 状态码 + 统一 envelope
      expect(res.statusCode, `${c.type}（${c.label}）应创建成功`).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.code).toBe(0);
      expect(body.code).toBe(0);

      // ② 载荷正确：trade_id / position / hold_rel 三件套齐全
      expect(body.data.trade_id, `${c.type} 必须返回 trade_id`).toBeGreaterThan(0);
      expect(body.data.position, `${c.type} 必须返回持仓快照`).toBeDefined();
      expect(typeof body.data.position.totalQuantity).toBe('number');
      expect(typeof body.data.position.avgCost).toBe('number');
      expect(body.data.hold_rel, `${c.type} 必须返回 hold 关系同步结果`).toBeDefined();

      // ③ 落库后能查回，且字段逐项正确
      const row = await fetchRow(c.code, c.type);
      expect(row, `${c.type} 必须落库`).toBeDefined();
      expect(row.asset_code).toBe(c.code);
      expect(row.trade_type).toBe(c.type);
      expect(row.trade_date).toBe(TRADE_DATE);
      expect(row.trade_time).toBe(c.tradeTime);
      expect(Number(row.quantity)).toBe(c.quantity);
      expect(Number(row.price)).toBe(c.price);
      expect(Number(row.fee)).toBe(c.fee);
      expect(row.is_deleted).toBe(0);

      // ④ 理由口径：用户填的**原样保留**；系统类的**由后端固化**
      if (c.reason) {
        expect(row.trade_reason, `${c.type} 的理由必须是用户填写的原文`).toBe(c.reason);
      } else {
        // 实测后端固化文案：自动导入 - {trade_date} {trade_type}（routes/trade.ts:279）
        expect(row.trade_reason, `${c.type} 的理由必须由系统固化`).toBe(`自动导入 - ${TRADE_DATE} ${c.type}`);
      }

      // ⑤ 持仓快照的数量口径（⚠️ 送股/转增为「当前实现口径」，偏差见文件头说明）
      expect(body.data.position.totalQuantity, `${c.type}（${c.label}）后的持仓数量`).toBe(c.expectQty);
    }
  });

  it('create_trade_all_types: 买入/加仓/减仓/清仓 缺 trade_reason → 400 TRADE_REASON_REQUIRED 且不落库', async () => {
    for (const type of ['buy', 'add', 'reduce', 'clear'] as const) {
      const code = `szG5NR${type}`;
      // 卖出类先给足底仓 ⇒ 若不是「缺理由」先被拦，失败原因唯一
      await seedHolding(code, 100, 10);

      const res = await bundle.app.inject({
        method: 'POST',
        url: '/api/trade',
        headers: authHeaders(),
        payload: {
          asset_code: code,
          trade_type: type,
          trade_date: TRADE_DATE,
          trade_time: '10:02:00',
          quantity: 10,
          price: 11,
          fee: 0,
          // ⚠️ 故意不传 trade_reason
        },
      });

      expect(res.statusCode, `${type} 缺理由应 400`).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('TRADE_REASON_REQUIRED');
      expect(body.code).toBe('TRADE_REASON_REQUIRED');
      expect('success' in body).toBe(false);
      expect(body.data).toBeNull();

      // 未落库（按**成交时刻**定位，避免误命中底仓那笔 buy）
      const row = await fetchRow(code, type, '10:02:00');
      expect(row, `${type} 缺理由不得落库`).toBeUndefined();
    }
  });

  it('create_trade_all_types: 分红/送股/转增 客户端显式传理由 → 后端原样保留（前端「人工补充 - {除权日} {类型}」口径）', async () => {
    const code = 'szG5MAN';
    await seedHolding(code, 100, 10);
    const reason = `人工补充 - ${TRADE_DATE} 分红`;

    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: code,
        trade_type: 'dividend',
        trade_date: TRADE_DATE,
        trade_time: '10:03:00',
        quantity: 100,
        price: 0.5,
        fee: 0,
        trade_reason: reason,
      },
    });

    expect(res.statusCode).toBe(201);
    const row = await fetchRow(code, 'dividend');
    expect(row).toBeDefined();
    expect(row.trade_reason, '客户端显式传的理由必须原样保留').toBe(reason);
  });

  it('create_trade_all_types: 7 种类型之外的 trade_type → 400 PARAM_INVALID（不落库、不 500）', async () => {
    const code = 'szG5BAD';
    wipeAsset(code);
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: authHeaders(),
      payload: {
        asset_code: code,
        trade_type: 'sell', // SDD §12.5 F2 原文里的「卖出」已不是合法类型（DEC-2 移除）
        trade_date: TRADE_DATE,
        trade_time: '10:04:00',
        quantity: 10,
        price: 11,
        trade_reason: '非法类型',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('PARAM_INVALID');
    // 不得外泄底层 SQLite 报错
    expect(res.body).not.toMatch(/CHECK constraint failed/i);
    expect(res.body).not.toMatch(/SQLITE_CONSTRAINT/i);
    const row = await fetchRow(code, 'sell');
    expect(row, '非法类型不得落库').toBeUndefined();
  });
});
