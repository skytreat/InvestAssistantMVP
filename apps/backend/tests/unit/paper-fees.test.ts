/**
 * PA-06 / 方案 §4.3 —— 费用配置：校验、快照、回退链
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPaperSchema } from '../../src/services/backtest/store/paperSchema.js';
import { DEFAULT_TRADE_RULES } from '../../src/services/backtest/execution/simulator.js';
import {
  createFeeConfig,
  deleteFeeConfig,
  ensureSystemDefaultFeeConfig,
  feeSnapshotToTradeRules,
  listFeeConfigs,
  resolveFeeConfig,
  updateFeeConfig,
  validateFeeConfig,
  type FeeSnapshot,
} from '../../src/services/paper/fees.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createPaperSchema(db);
});

describe('validateFeeConfig', () => {
  it('缺省值等于内置默认（无印花税 / 过户费）', () => {
    const v = validateFeeConfig({});
    expect(v.commissionRate).toBe(DEFAULT_TRADE_RULES.commissionRate);
    expect(v.minCommission).toBe(DEFAULT_TRADE_RULES.minCommission);
    expect(v.slippageRate).toBe(DEFAULT_TRADE_RULES.slippageRate);
    expect(v.priceLimitPct).toBe(DEFAULT_TRADE_RULES.priceLimit);
    expect(v.stampDutyRate).toBe(0);
    expect(v.transferFeeRate).toBe(0);
  });

  it('拒绝越界费率、非法 lotSize', () => {
    expect(() => validateFeeConfig({ commissionRate: 0.01 })).toThrow(/commissionRate/);
    expect(() => validateFeeConfig({ slippageRate: -1 })).toThrow(/slippageRate/);
    expect(() => validateFeeConfig({ lotSize: 1.5 })).toThrow(/lotSize/);
    expect(() => validateFeeConfig({ minNotional: -1 })).toThrow(/minNotional/);
  });

  it('接受印花税 / 过户费（D1 起模拟器支持，不再拒绝）', () => {
    const v = validateFeeConfig({ stampDutyRate: 0.001, transferFeeRate: 0.00002 });
    expect(v.stampDutyRate).toBe(0.001);
    expect(v.transferFeeRate).toBe(0.00002);
  });

  it('印花税 / 过户费仍受 0~0.001 范围约束', () => {
    expect(() => validateFeeConfig({ stampDutyRate: 0.002 })).toThrow(/stampDutyRate/);
    expect(() => validateFeeConfig({ transferFeeRate: -0.0001 })).toThrow(/transferFeeRate/);
  });
});

describe('feeSnapshotToTradeRules', () => {
  it('逐字段映射到模拟器 TradeRules', () => {
    const snap: FeeSnapshot = {
      source: 'user',
      feeConfigId: 7,
      name: 'q',
      brokerName: null,
      commissionRate: 0.0002,
      minCommission: 6,
      stampDutyRate: 0,
      transferFeeRate: 0,
      slippageRate: 0.0002,
      lotSize: 200,
      minNotional: 20,
      priceLimitPct: 0.2,
    };
    expect(feeSnapshotToTradeRules(snap)).toEqual({
      commissionRate: 0.0002,
      minCommission: 6,
      stampDutyRate: 0,
      transferFeeRate: 0,
      slippageRate: 0.0002,
      lotSize: 200,
      minNotional: 20,
      priceLimit: 0.2,
    });
  });

  it('快照含非 0 印花税时进入结算规则（D1 起支持）', () => {
    const rules = feeSnapshotToTradeRules({
      source: 'builtin',
      feeConfigId: null,
      name: 'x',
      brokerName: null,
      commissionRate: 0.0001,
      minCommission: 5,
      stampDutyRate: 0.001,
      transferFeeRate: 0.00002,
      slippageRate: 0.0001,
      lotSize: 100,
      minNotional: 10,
      priceLimitPct: 0.1,
    });
    expect(rules.stampDutyRate).toBe(0.001);
    expect(rules.transferFeeRate).toBe(0.00002);
  });

  it('旧快照缺印花税 / 过户费字段时按 0 解读（不报错）', () => {
    const legacy = {
      source: 'builtin',
      feeConfigId: null,
      name: 'x',
      brokerName: null,
      commissionRate: 0.0001,
      minCommission: 5,
      slippageRate: 0.0001,
      lotSize: 100,
      minNotional: 10,
      priceLimitPct: 0.1,
    } as unknown as FeeSnapshot;
    const rules = feeSnapshotToTradeRules(legacy);
    expect(rules.stampDutyRate).toBe(0);
    expect(rules.transferFeeRate).toBe(0);
  });
});

describe('resolveFeeConfig 回退链（账户 → 用户 → 系统 → 内置）', () => {
  it('没有系统默认、也没有用户配置 → builtin', () => {
    const snap = resolveFeeConfig(db, { userId: 1 });
    expect(snap.source).toBe('builtin');
    expect(snap.feeConfigId).toBeNull();
    expect(snap.commissionRate).toBe(DEFAULT_TRADE_RULES.commissionRate);
  });

  it('有系统默认 → system', () => {
    ensureSystemDefaultFeeConfig(db);
    ensureSystemDefaultFeeConfig(db); // 幂等
    const snap = resolveFeeConfig(db, { userId: 1 });
    expect(snap.source).toBe('system');
    expect(snap.feeConfigId).not.toBeNull();
  });

  it('用户默认优先于系统默认（取本人最早一条）', () => {
    ensureSystemDefaultFeeConfig(db);
    const first = createFeeConfig(db, 1, { name: '我的A', commissionRate: 0.0002 });
    createFeeConfig(db, 1, { name: '我的B', commissionRate: 0.0003 });
    const snap = resolveFeeConfig(db, { userId: 1 });
    expect(snap.source).toBe('user');
    expect(snap.feeConfigId).toBe(first.id);
    expect(snap.commissionRate).toBe(0.0002);
  });

  it('显式 feeConfigId 优先（账户级），且允许引用系统配置', () => {
    ensureSystemDefaultFeeConfig(db);
    const mine = createFeeConfig(db, 1, { name: '我的', commissionRate: 0.00025 });
    const own = resolveFeeConfig(db, { userId: 1, feeConfigId: mine.id });
    expect(own.source).toBe('account');
    expect(own.commissionRate).toBe(0.00025);

    const system = listFeeConfigs(db, 1).find((c) => c.isSystemDefault)!;
    expect(resolveFeeConfig(db, { userId: 1, feeConfigId: system.id }).source).toBe('system');
  });

  it('不能引用他人的配置（403），不存在给 400', () => {
    const other = createFeeConfig(db, 2, { name: '别人', commissionRate: 0.0001 });
    expect(() => resolveFeeConfig(db, { userId: 1, feeConfigId: other.id })).toThrow(/其他用户/);
    expect(() => resolveFeeConfig(db, { userId: 1, feeConfigId: 999 })).toThrow(/不存在/);
  });
});

describe('费用配置 CRUD', () => {
  it('创建 → 列表 → 更新 → 软删除', () => {
    const c = createFeeConfig(db, 1, { name: '券商A', brokerName: 'A', commissionRate: 0.0002 });
    expect(listFeeConfigs(db, 1).map((x) => x.id)).toContain(c.id);

    const u = updateFeeConfig(db, 1, c.id, { minCommission: 3 });
    expect(u.minCommission).toBe(3);

    deleteFeeConfig(db, 1, c.id);
    expect(listFeeConfigs(db, 1).map((x) => x.id)).not.toContain(c.id);
  });

  it('同名重复拒绝；他人配置不可改/删', () => {
    ensureSystemDefaultFeeConfig(db);
    createFeeConfig(db, 1, { name: '同名' });
    expect(() => createFeeConfig(db, 1, { name: '同名' })).toThrow(/已存在/);

    const system = listFeeConfigs(db, 1).find((c) => c.isSystemDefault)!;
    expect(() => updateFeeConfig(db, 1, system.id, { minCommission: 3 })).toThrow(/不可修改/);
    expect(() => deleteFeeConfig(db, 1, system.id)).toThrow(/不可删除/);
  });
});
