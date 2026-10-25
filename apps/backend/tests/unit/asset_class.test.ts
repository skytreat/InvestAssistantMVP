/**
 * asset_class.test.ts — T120（V3.0b）标的资产分类（风险 / 现金）
 * 对应 SDD_v3 §12.1 不变量映射：INV-S4-8~17（现金类分类 + 分类表与人工修正）
 *
 * 实测锚点（2026-10-25 真库）：
 * - 货币 ETF 近 250 日振幅 ≤ 4.05%（511600），股票/现金流/黄金 ETF ≥ 20.89%
 * - 逆回购收录段 sh204001~004/007 + sz131810/131811
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-assetclass-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import {
  classifySymbol,
  runInitialClassification,
  setManualClass,
  getAssetClass,
  listUnclassified,
  REPO_CODES,
  type ClassifyInput,
} from '../../src/services/assetClass.js';

let db: Database.Database;
let uid: number;

// 单测不碰 DuckDB：注入行情层窗口统计（值 = 2026-10-25 真库实测）
const MEASURED: Record<string, ClassifyInput> = {
  sh511990: {
    code: 'sh511990',
    name: '华宝添益ETF',
    latestClose: 100.004,
    winLo: 99.987,
    winHi: 100.045,
    winBars: 262,
  },
  sh511880: {
    code: 'sh511880',
    name: '银华日利ETF',
    latestClose: 100.918,
    winLo: 100.048,
    winHi: 101.195,
    winBars: 262,
  },
  sh511600: {
    code: 'sh511600',
    name: '天弘货币ETF',
    latestClose: 100,
    winLo: 99.991,
    winHi: 104.039,
    winBars: 262,
  },
  sh512130: {
    code: 'sh512130',
    name: '全指现金流ETF华泰平安',
    latestClose: 1.089,
    winLo: 1.089,
    winHi: 1.405,
    winBars: 262,
  },
  sh510300: {
    code: 'sh510300',
    name: '沪深300ETF',
    latestClose: 4.107,
    winLo: 4.107,
    winHi: 5.091,
    winBars: 262,
  },
  sz159368: {
    code: 'sz159368',
    name: '创业板ETF',
    latestClose: 0.509,
    winLo: 0.509,
    winHi: 1.766,
    winBars: 262,
  },
  sh204001: { code: 'sh204001', name: 'GC001' },
  sz131810: { code: 'sz131810', name: 'R-001' },
  sh600519: { code: 'sh600519', name: '贵州茅台', latestClose: 1450, winLo: 1400, winHi: 1600, winBars: 262 },
};
const fakeProvider = async (codes: string[]): Promise<ClassifyInput[]> =>
  codes.map((c) => MEASURED[c] ?? { code: c });

beforeAll(() => {
  const store = ConfigStore.getInstance();
  db = store.db;
  store.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(5001, 'user_5001', 'x');
  uid = 5001;
});

afterAll(() => {
  try {
    (db as unknown as { close(): void }).close();
  } catch {
    /* ignore */
  }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

describe('T120 · classifySymbol 纯规则（INV-S4-8~15）', () => {
  it('repo_code：逆回购品种段直接判 cash（实测清单 7 个）', () => {
    expect(REPO_CODES.size).toBe(7);
    for (const code of REPO_CODES) {
      expect(classifySymbol({ code, name: 'x', latestClose: 1.465 }).rule_hit).toBe('repo_code');
      expect(classifySymbol({ code }).asset_class).toBe('cash'); // 无行情统计也判 cash
    }
  });

  it('cash_etf_near_par：无名称、仅价格带+振幅 ⇒ cash（带 rule_hit 可审计）', () => {
    const r = classifySymbol({
      code: 'sh511990',
      latestClose: 100.004,
      winLo: 99.987,
      winHi: 100.045,
      winBars: 262,
    });
    expect(r.asset_class).toBe('cash');
    expect(r.rule_hit).toBe('cash_etf_near_par');
  });

  it('cash_etf_name：名称关键词 + 价格带佐证同成立 ⇒ rule_hit 记名称', () => {
    expect(classifySymbol(MEASURED.sh511990).rule_hit).toBe('cash_etf_name');
    expect(classifySymbol(MEASURED.sh511880).rule_hit).toBe('cash_etf_name');
    expect(classifySymbol(MEASURED.sh511600).asset_class).toBe('cash'); // 4.05% 振幅贴 5% 阈值内
  });

  it('名称单独不得定案（INV-S4-15）：「现金流」ETF 含「现金」二字但振幅 26% ⇒ risk', () => {
    const r = classifySymbol(MEASURED.sh512130);
    expect(r.asset_class).toBe('risk');
    expect(r.rule_hit).toBe('default');
  });

  it('default：股票 / 大振幅 ETF ⇒ risk', () => {
    expect(classifySymbol(MEASURED.sh510300)).toEqual({
      code: 'sh510300',
      asset_class: 'risk',
      rule_hit: 'default',
    });
    expect(classifySymbol(MEASURED.sz159368).asset_class).toBe('risk');
    expect(classifySymbol(MEASURED.sh600519).asset_class).toBe('risk');
  });

  it('新上市窗口不足（<120 根）不做 near_par 判定 ⇒ risk（保守）', () => {
    const r = classifySymbol({
      code: 'sh588000',
      name: '货币ETF新',
      latestClose: 100,
      winLo: 99.9,
      winHi: 100.1,
      winBars: 50,
    });
    expect(r.asset_class).toBe('risk');
    expect(r.rule_hit).toBe('default');
  });

  it('repo_code 优先级最高（逆回购无日线统计也判 cash）', () => {
    const r = classifySymbol({
      code: 'sz131810',
      name: 'R-001',
      latestClose: 1.85,
      winLo: 1.8,
      winHi: 1.9,
      winBars: 262,
    });
    expect(r.rule_hit).toBe('repo_code');
    expect(r.asset_class).toBe('cash');
  });
});

describe('T120 · 落库与人工修正（INV-S4-14~17）', () => {
  // ⚠️ 本套件 sequence.shuffle=true（T81 顺序守卫）⇒ 每个用例必须自包含，
  // 不得依赖其它用例的写入。各用例用专属 code 段（sh6000xx / sz0000xx / sh6880xx）。

  it('runInitialClassification：新标的写入 rule 行', async () => {
    const r = await runInitialClassification(db, ['sh688001', 'sh688002', 'sh688003'], fakeProvider);
    expect(r.written.map((x) => x.code).sort()).toEqual(['sh688001', 'sh688002', 'sh688003']);
    expect(r.skippedExisting).toEqual([]);
    // fakeProvider 对这些 code 无窗口统计（MEASURED 里没有）⇒ default=risk 且列入 unclassifiable
    expect(r.unclassifiable.sort()).toEqual(['sh688001', 'sh688002', 'sh688003']);
    expect(getAssetClass(db, 'sh688001')).toBe('risk');
  });

  it('重跑规则不覆盖已有记录（含 manual）', async () => {
    // 自包含：先写 sz000001（有窗口统计 ⇒ 判 cash），再重跑
    await runInitialClassification(db, ['sz000001', 'sz000002'], fakeProvider);
    setManualClass(db, uid, 'sz000001', 'risk');
    const r = await runInitialClassification(db, ['sz000001', 'sz000002', 'sz000003'], fakeProvider);
    expect(r.skippedExisting.sort()).toEqual(['sz000001', 'sz000002']); // 已有（rule / manual）不覆盖
    expect(r.written.map((x) => x.code)).toEqual(['sz000003']); // 只有新标的写入
    expect(getAssetClass(db, 'sz000001')).toBe('risk'); // manual 值仍在
  });

  it('人工修正优先：manual 写后规则重跑不覆盖，且 rule_hit 保留初判值', async () => {
    // 自包含：sz000004 走 cash_etf_near_par 初判（MEASURED 无此 code ⇒ 用内联统计）
    const provider = async (codes: string[]) =>
      codes.map((c) =>
        c === 'sz000004'
          ? { code: c, latestClose: 100, winLo: 99.99, winHi: 100.01, winBars: 262 }
          : { code: c },
      );
    const first = await runInitialClassification(db, ['sz000004'], provider);
    expect(first.written[0].rule_hit).toBe('cash_etf_near_par');

    setManualClass(db, uid, 'sz000004', 'risk');
    const row = db
      .prepare(`SELECT asset_class, source, rule_hit, updated_by FROM asset_class WHERE symbol = ?`)
      .get('sz000004') as { asset_class: string; source: string; rule_hit: string; updated_by: number };
    expect(row.asset_class).toBe('risk');
    expect(row.source).toBe('manual');
    expect(row.rule_hit).toBe('cash_etf_near_par'); // 初判值保留，可回溯
    expect(row.updated_by).toBe(uid);

    await runInitialClassification(db, ['sz000004'], provider); // 规则仍会说 cash
    const after = db
      .prepare(`SELECT asset_class, source, rule_hit FROM asset_class WHERE symbol = ?`)
      .get('sz000004') as { asset_class: string; source: string; rule_hit: string };
    expect(after.asset_class).toBe('risk'); // 人工优先
    expect(after.source).toBe('manual');
    expect(after.rule_hit).toBe('cash_etf_near_par'); // 不被规则洗掉
  });

  it('无记录标的默认 risk，且 listUnclassified 可列出（不得静默）', () => {
    // 专属 code：无任何用例写入 sh601318 / sz159999
    expect(getAssetClass(db, 'sh601318')).toBe('risk');
    const missing = listUnclassified(db, ['sh601318', 'sz159999']);
    expect(missing.sort()).toEqual(['sh601318', 'sz159999']);
    expect(listUnclassified(db, [])).toEqual([]);
  });

  it('DDL 约束：asset_class / source 只接受枚举值（CHECK）', () => {
    expect(() =>
      db
        .prepare(`INSERT INTO asset_class (symbol, asset_class, source) VALUES ('sh600000', 'mixed', 'rule')`)
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(`INSERT INTO asset_class (symbol, asset_class, source) VALUES ('sh600001', 'risk', 'auto')`)
        .run(),
    ).toThrow();
  });
});
