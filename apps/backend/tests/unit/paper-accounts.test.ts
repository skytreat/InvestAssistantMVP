/**
 * PA-07 —— 建户 / 查询 / 关闭 / 手动切阶段（服务层）
 *
 * 切阶段的日历依赖通过 `loadHolidays` 注入，避免测试绑死真实行情库；
 * HTTP 层只做参数与确认校验（见 `tests/integration/paper-api.test.ts`）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPaperSchema } from '../../src/services/backtest/store/paperSchema.js';
import { PaperError } from '../../src/services/paper/errors.js';
import {
  createFeeConfig,
  ensureSystemDefaultFeeConfig,
  updateFeeConfig,
} from '../../src/services/paper/fees.js';
import {
  changePaperPhase,
  closePaperAccount,
  createPaperAccount,
  getPaperAccount,
  listPaperAccounts,
} from '../../src/services/paper/accountService.js';

const WUFU = { strategyId: 'wufu-rotation', strategyVersion: '5.2.0-m3' };
const HOLIDAYS = ['2026-01-01'];

let db: Database.Database;
let biz: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createPaperSchema(db);
  ensureSystemDefaultFeeConfig(db);

  biz = new Database(':memory:');
  biz.exec(`CREATE TABLE user_account (id INTEGER PRIMARY KEY, username TEXT)`);
  biz.prepare(`INSERT INTO user_account (id, username) VALUES (1, 'u1'), (2, 'u2')`).run();
});

function makeAccount(overrides: Partial<Parameters<typeof createPaperAccount>[2]> = {}) {
  return createPaperAccount(db, biz, {
    userId: 1,
    ...WUFU,
    initialCash: 100_000,
    ...overrides,
  } as Parameters<typeof createPaperAccount>[2]);
}

function insertShadowOrder(accountId: number) {
  db.prepare(
    `INSERT INTO paper_order (
       account_id, signal_id, decision_date, trade_date, seq, asset_code,
       intent_kind, side, rebalance_mode, target_weight, target_notional, cutoff_equity,
       intent_notional, status
     ) VALUES (?, ?, '2026-11-05', '2026-11-06', 0, 'sh510300', 'target', 'buy', 'replace', 1, 100000, 100000, 100000, 'shadow')`,
  ).run(accountId, `psig_${accountId}_2026-11-05_sh510300`);
}

describe('建户', () => {
  it('默认影子期、现金 = 初始资金、策略版本精确锁定', () => {
    const acc = makeAccount();
    expect(acc.phase).toBe('shadow');
    expect(acc.status).toBe('active');
    expect(acc.cash).toBe(100_000);
    expect(acc.ledgerStartDate).toBeNull();
    expect(acc.strategyId).toBe('wufu-rotation');
    expect(acc.strategyVersion).toBe('5.2.0-m3');
    expect(acc.params).toMatchObject({});
    expect(acc.feeSnapshot.source).toBe('system');
  });

  it('策略 id / 版本不匹配分别是两类错误', () => {
    expect(() => makeAccount({ strategyId: 'nope', strategyVersion: 'x' })).toThrow(PaperError);
    expect(() => makeAccount({ strategyId: 'nope', strategyVersion: 'x' })).toThrow(/未登记/);
    expect(() => makeAccount({ strategyVersion: '9.9.9' })).toThrow(/不存在版本/);
  });

  it('初始资金必须为正、用户必须存在', () => {
    expect(() => makeAccount({ initialCash: 0 })).toThrow(/initialCash/);
    expect(() => makeAccount({ userId: 99 })).toThrow(/不存在/);
  });

  it('单用户单账户：第二个在建账户 409', () => {
    makeAccount({ name: 'A' });
    try {
      makeAccount({ name: 'B' });
      throw new Error('应该失败');
    } catch (err) {
      expect((err as PaperError).code).toBe('PAPER_ACCOUNT_EXISTS');
      expect((err as PaperError).status).toBe(409);
    }
  });

  it('费用快照在建户时冻结，之后改配置不影响账户', () => {
    const mine = createFeeConfig(db, 1, { name: '我的', commissionRate: 0.00025 });
    const acc = makeAccount({ feeConfigId: mine.id });
    expect(acc.feeSnapshot.commissionRate).toBe(0.00025);

    updateFeeConfig(db, 1, mine.id, { commissionRate: 0.0003 });
    expect(getPaperAccount(db, 1, acc.id).feeSnapshot.commissionRate).toBe(0.00025);
  });

  it('列表只返回本人账户', () => {
    const mine = makeAccount();
    const other = makeAccount({ userId: 2, name: 'B' });
    expect(listPaperAccounts(db, 1).map((a) => a.id)).toEqual([mine.id]);
    expect(listPaperAccounts(db, 2).map((a) => a.id)).toEqual([other.id]);
    // 跨用户直查 → 404
    expect(() => getPaperAccount(db, 2, mine.id)).toThrow(/不存在/);
  });

  it('关闭后状态 closed，且可再建新账户', () => {
    const acc = makeAccount();
    expect(closePaperAccount(db, 1, acc.id).status).toBe('closed');
    expect(() => makeAccount({ name: 'C' })).not.toThrow();
  });
});

describe('手动切换阶段（shadow → ledger，冷启动）', () => {
  it('未确认 / 方向非法 → 拒绝', async () => {
    const acc = makeAccount();
    await expect(
      changePaperPhase(db, 1, acc.id, {
        to: 'ledger',
        confirm: false,
        today: '2026-11-06',
        loadHolidays: async () => HOLIDAYS,
      }),
    ).rejects.toMatchObject({ code: 'PAPER_CONFIRM_REQUIRED' });
    await expect(
      changePaperPhase(db, 1, acc.id, {
        to: 'shadow',
        confirm: true,
        today: '2026-11-06',
        loadHolidays: async () => HOLIDAYS,
      }),
    ).rejects.toMatchObject({ code: 'PAPER_PHASE_NOT_ALLOWED' });
  });

  it('成功切换：phase=ledger、现金重置、水位清空、仓位清空、影子订单保留', async () => {
    const acc = makeAccount();
    insertShadowOrder(acc.id);
    // 制造「已结算过」的假象，验证被清掉
    db.prepare(
      `INSERT INTO paper_position (account_id, asset_code, qty, avg_cost, cost_basis) VALUES (?, 'sh510300', 100, 1, 100)`,
    ).run(acc.id);
    db.prepare(
      `UPDATE paper_account SET cash = 12345, last_decision_date = '2026-11-05', last_settled_date = '2026-11-05' WHERE id = ?`,
    ).run(acc.id);

    const after = await changePaperPhase(db, 1, acc.id, {
      to: 'ledger',
      confirm: true,
      today: '2026-11-06', // 周五
      loadHolidays: async () => HOLIDAYS,
    });

    expect(after.phase).toBe('ledger');
    expect(after.cash).toBe(100_000);
    expect(after.lastDecisionDate).toBeNull();
    expect(after.lastSettledDate).toBeNull();
    expect(after.ledgerStartDate).toBe('2026-11-09'); // 周一
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM paper_position WHERE account_id = ?`).get(acc.id) as {
          n: number;
        }
      ).n,
    ).toBe(0);
    // 影子订单永久保留、不补记成交
    const shadow = db
      .prepare(`SELECT status, filled_qty FROM paper_order WHERE account_id = ?`)
      .get(acc.id) as {
      status: string;
      filled_qty: number;
    };
    expect(shadow).toEqual({ status: 'shadow', filled_qty: 0 });
    // 种子净值点
    const seed = db
      .prepare(`SELECT equity, cash FROM paper_equity WHERE account_id = ? AND trade_date = ?`)
      .get(acc.id, '2026-11-09') as { equity: number; cash: number };
    expect(seed).toEqual({ equity: 100_000, cash: 100_000 });
  });

  it('有 pending 订单 → 409；已是 ledger → 409；非 active → 409', async () => {
    const acc = makeAccount();
    db.prepare(
      `INSERT INTO paper_order (
         account_id, signal_id, decision_date, trade_date, seq, asset_code,
         intent_kind, side, rebalance_mode, cutoff_equity, status
       ) VALUES (?, 'p1', '2026-11-05', '2026-11-06', 0, 'sh510300', 'target', 'buy', 'replace', 100000, 'pending')`,
    ).run(acc.id);
    await expect(
      changePaperPhase(db, 1, acc.id, {
        to: 'ledger',
        confirm: true,
        today: '2026-11-06',
        loadHolidays: async () => HOLIDAYS,
      }),
    ).rejects.toMatchObject({ code: 'PAPER_PENDING_EXISTS' });

    db.prepare(`DELETE FROM paper_order WHERE account_id = ?`).run(acc.id);
    await changePaperPhase(db, 1, acc.id, {
      to: 'ledger',
      confirm: true,
      today: '2026-11-06',
      loadHolidays: async () => HOLIDAYS,
    });
    await expect(
      changePaperPhase(db, 1, acc.id, {
        to: 'ledger',
        confirm: true,
        today: '2026-11-09',
        loadHolidays: async () => HOLIDAYS,
      }),
    ).rejects.toMatchObject({ code: 'PAPER_PHASE_TRANSITION_INVALID' });

    const acc2 = makeAccount({ userId: 2, name: 'b' });
    closePaperAccount(db, 2, acc2.id);
    await expect(
      changePaperPhase(db, 2, acc2.id, {
        to: 'ledger',
        confirm: true,
        today: '2026-11-06',
        loadHolidays: async () => HOLIDAYS,
      }),
    ).rejects.toMatchObject({ code: 'PAPER_ACCOUNT_NOT_ACTIVE' });
  });

  it('跨用户切阶段 → 404', async () => {
    const acc = makeAccount();
    await expect(
      changePaperPhase(db, 2, acc.id, {
        to: 'ledger',
        confirm: true,
        today: '2026-11-06',
        loadHolidays: async () => HOLIDAYS,
      }),
    ).rejects.toMatchObject({ code: 'PAPER_ACCOUNT_NOT_FOUND' });
  });

  it('日历不可用 → 503，且账户保持 shadow（无半切换）', async () => {
    const acc = makeAccount();
    await expect(
      changePaperPhase(db, 1, acc.id, {
        to: 'ledger',
        confirm: true,
        today: '2026-11-06',
        loadHolidays: async () => {
          throw new Error('duckdb down');
        },
      }),
    ).rejects.toMatchObject({ code: 'CALENDAR_UNAVAILABLE', status: 503 });
    expect(getPaperAccount(db, 1, acc.id).phase).toBe('shadow');
  });
});
