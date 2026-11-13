/**
 * assetClassSync.test.ts —— asset_class 初判接线（T120 补充）
 *
 * 重点保证「默认不落库」：dry-run 只出预览、真实库零写入；
 * execute 幂等：已有 rule/manual 记录不被覆盖，重复执行不新增。
 * 全部用 `:memory:` + 注入 inputProvider，不碰 DuckDB。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ASSET_CLASS_SYNC_ENV,
  collectBusinessSymbols,
  previewAssetClassSync,
  renderSyncReport,
  resolveSyncMode,
  runAssetClassSyncIfNeeded,
  selectClassifyCandidates,
  syncAssetClass,
} from '../../src/services/assetClassSync.js';
import type { ClassifyInput } from '../../src/services/assetClass.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE user_trade_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, asset_code TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_asset_rel (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, asset_code TEXT NOT NULL,
      rel_type TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE asset_class (
      symbol TEXT PRIMARY KEY,
      asset_class TEXT NOT NULL CHECK (asset_class IN ('risk','cash')),
      rule_hit TEXT, source TEXT NOT NULL CHECK (source IN ('rule','manual')),
      updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  return db;
}

/** 2026-10-25 真库实测值（与 asset_class.test.ts 同一批锚点） */
const MEASURED: Record<string, ClassifyInput> = {
  sh511990: {
    code: 'sh511990',
    name: '华宝添益ETF',
    latestClose: 100.004,
    winLo: 99.987,
    winHi: 100.045,
    winBars: 262,
  },
  sh204001: { code: 'sh204001', name: 'GC001', winBars: 250 },
  sh510300: { code: 'sh510300', name: '沪深300ETF', latestClose: 4.2, winLo: 3.4, winHi: 4.4, winBars: 250 },
  sh512130: { code: 'sh512130', name: '现金流ETF', latestClose: 1.1, winLo: 0.9, winHi: 1.2, winBars: 250 },
  sh511880: {
    code: 'sh511880',
    name: '银华日利ETF',
    latestClose: 100.918,
    winLo: 100.048,
    winHi: 101.195,
    winBars: 262,
  },
};

const provider = async (codes: string[]) => codes.map((c) => MEASURED[c] ?? { code: c });

function seedBusiness(db: Database.Database) {
  const t = db.prepare(`INSERT INTO user_trade_record (user_id, asset_code) VALUES (1, ?)`);
  for (const s of ['sh511990', 'sh204001', 'sh510300', 'sh512130']) t.run(s);
  db.prepare(
    `INSERT INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (1, 'sh511990', 'hold')`,
  ).run();
}

function count(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM asset_class`).get() as { n: number }).n;
}

describe('assetClassSync · resolveSyncMode（安全默认）', () => {
  it('未设置/空串/未知拼写 ⇒ dry-run（拼错不会误落库）', () => {
    expect(resolveSyncMode(undefined)).toBe('dry-run');
    expect(resolveSyncMode('')).toBe('dry-run');
    expect(resolveSyncMode('exectue')).toBe('dry-run');
    expect(resolveSyncMode('EXECUTE')).toBe('execute');
    expect(resolveSyncMode('off')).toBe('off');
  });
});

describe('assetClassSync · dry-run（只读，不写库）', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedBusiness(db);
  });
  afterEach(() => db.close());

  it('业务层标的汇总（成交/关联计数，跨用户去重）', () => {
    const u = collectBusinessSymbols(db);
    expect(u.map((x) => x.symbol)).toEqual(['sh204001', 'sh510300', 'sh511990', 'sh512130']);
    expect(u.find((x) => x.symbol === 'sh511990')).toEqual({ symbol: 'sh511990', trades: 1, rels: 1 });
  });

  it('dry-run 产出 cash 预览但 asset_class 仍 0 行', async () => {
    const r = await syncAssetClass(db, 'dry-run', provider);
    expect(r.mode).toBe('dry-run');
    expect(r.writtenCount).toBe(0);
    expect(count(db)).toBe(0);

    const cash = r.rows
      .filter((x) => x.nextClass === 'cash')
      .map((x) => x.symbol)
      .sort();
    expect(cash).toEqual(['sh204001', 'sh511990']);
    expect(r.rows.every((x) => x.willWrite)).toBe(true); // 表为空 ⇒ 全部「会写入」
    expect(r.rows.find((x) => x.symbol === 'sh204001')?.nextRuleHit).toBe('repo_code');
    expect(r.rows.find((x) => x.symbol === 'sh511990')?.nextRuleHit).toBe('cash_etf_name');
  });

  it('off 模式不取数不返回', async () => {
    const r = await syncAssetClass(db, 'off', provider);
    expect(r.mode).toBe('off');
    expect(r.rows).toHaveLength(0);
  });

  it('报告含现金清单与全量明细', async () => {
    const r = await previewAssetClassSync(db, provider);
    const md = renderSyncReport(r, { dbPath: 'x.db', duckdbPath: 'q.duckdb', generatedAt: 't' });
    expect(md).toContain('会被判成 cash 的标的（2 个）');
    expect(md).toContain('sh511990');
    expect(md).toContain('全量明细（4 行）');
  });
});

describe('assetClassSync · execute（增量：改判 / 刷新 / 保护，ADR-024）', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedBusiness(db);
  });
  afterEach(() => db.close());

  it('execute 首次写入 4 条（rule 行含 default 与终态）', async () => {
    const r1 = await syncAssetClass(db, 'execute', provider);
    expect(r1.writtenCount).toBe(4);
    expect(count(db)).toBe(4);
    const cashRow = db.prepare(`SELECT * FROM asset_class WHERE symbol = ?`).get('sh511990') as {
      asset_class: string;
      rule_hit: string;
      source: string;
    };
    expect(cashRow.asset_class).toBe('cash');
    expect(cashRow.rule_hit).toBe('cash_etf_name');
    expect(cashRow.source).toBe('rule');
  });

  it('立即重跑：终态不动、default 仅刷新冷却标记（不计 written）', async () => {
    await syncAssetClass(db, 'execute', provider);
    const r2 = await syncAssetClass(db, 'execute', provider);
    expect(r2.writtenCount).toBe(0);
    expect(r2.refreshedCount).toBe(2); // sh510300/sh512130 仍 default ⇒ 刷新时间戳
    expect(r2.skippedExisting.length).toBe(4);
    expect(count(db)).toBe(4);
  });

  it('rule/default 行冷却期外 ⇒ 允许改判（新上市标的攒够 K 线后 risk→cash）', async () => {
    await syncAssetClass(db, 'execute', provider);
    expect(
      (
        db.prepare(`SELECT asset_class FROM asset_class WHERE symbol = ?`).get('sh510300') as {
          asset_class: string;
        }
      ).asset_class,
    ).toBe('risk');
    // 把 updated_at 拨到 8 天前（超过 7 天冷却）
    db.prepare(
      `UPDATE asset_class SET updated_at = datetime('now','localtime','-8 days') WHERE symbol = 'sh510300'`,
    ).run();
    // 模拟行情窗口补齐后规则改判 cash
    const r2 = await syncAssetClass(db, 'execute', async () => [
      { code: 'sh510300', name: '华宝添益ETF', latestClose: 100, winLo: 99.9, winHi: 100.1, winBars: 262 },
    ]);
    // sh204001/sh511990 终态 skip；sh512130 冷却期内 skip；sh510300 冷却期外改判
    expect(r2.writtenCount).toBe(1);
    expect(r2.skippedExisting.length).toBe(3);
    expect(r2.refreshedCount).toBe(1);
    const row = db
      .prepare(`SELECT asset_class, rule_hit, source FROM asset_class WHERE symbol = ?`)
      .get('sh510300') as { asset_class: string; rule_hit: string; source: string };
    expect(row).toEqual({ asset_class: 'cash', rule_hit: 'cash_etf_name', source: 'rule' });
  });

  it('仍为 default 的 rule 行只刷新 updated_at（不计 written）', async () => {
    await syncAssetClass(db, 'execute', provider);
    db.prepare(
      `UPDATE asset_class SET updated_at = datetime('now','localtime','-8 days') WHERE symbol = 'sh510300'`,
    ).run();
    const r = await syncAssetClass(db, 'execute', provider);
    // sh510300 仍 default（provider 里振幅 20%）⇒ 只刷新；sh512130 默认也刷新；
    // sh204001/sh511990 终态 skip
    expect(r.writtenCount).toBe(0);
    expect(r.refreshedCount).toBe(2);
    const row = db
      .prepare(`SELECT asset_class, updated_at FROM asset_class WHERE symbol = ?`)
      .get('sh510300') as { asset_class: string; updated_at: string };
    expect(row.asset_class).toBe('risk');
    // 刷新后的 updated_at 应等于当前时间（冷却标记重置）
    const now = (db.prepare(`SELECT datetime('now','localtime') AS t`).get() as { t: string }).t;
    expect(row.updated_at).toBe(now);
  });

  it('已有 manual 修正不被规则改判覆盖', async () => {
    db.prepare(
      `INSERT INTO asset_class (symbol, asset_class, rule_hit, source, updated_by)
        VALUES ('sh510300', 'cash', 'default', 'manual', 1)`,
    ).run();
    const r = await syncAssetClass(db, 'execute', provider);
    const row = db
      .prepare(`SELECT asset_class, rule_hit, source FROM asset_class WHERE symbol = ?`)
      .get('sh510300') as { asset_class: string; rule_hit: string; source: string };
    expect(row).toEqual({ asset_class: 'cash', rule_hit: 'default', source: 'manual' });
    expect(r.skippedExisting).toContain('sh510300'); // manual 永不被改
    // 其余 3 个首次插入：sh204001/sh511990 终态、sh512130 default
    expect(r.writtenCount).toBe(3);
    expect(r.refreshedCount).toBe(0);
  });
});

describe('assetClassSync · selectClassifyCandidates（增量候选，ADR-024）', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedBusiness(db);
  });
  afterEach(() => db.close());

  it('空表 ⇒ 4 个业务标的全部是 new 候选', () => {
    expect(selectClassifyCandidates(db).map((c) => [c.symbol, c.reason])).toEqual([
      ['sh204001', 'new'],
      ['sh510300', 'new'],
      ['sh511990', 'new'],
      ['sh512130', 'new'],
    ]);
  });

  it('rule/default 冷却期内（7 天）⇒ 不是候选；冷却期外 ⇒ retry', async () => {
    await syncAssetClass(db, 'execute', provider); // 4 条 rule 行，updated_at=now
    expect(selectClassifyCandidates(db)).toEqual([]); // 全部刚复查过
    db.prepare(`UPDATE asset_class SET updated_at = datetime('now','localtime','-8 days')`).run();
    const c = selectClassifyCandidates(db);
    // sh511990/sh204001 终态（cash_etf_name/repo_code）⇒ 永不候选；sh510300/sh512130 是 rule/default ⇒ retry
    expect(c.map((x) => [x.symbol, x.reason])).toEqual([
      ['sh510300', 'retry'],
      ['sh512130', 'retry'],
    ]);
  });

  it('manual 行与终态行永不候选', async () => {
    db.prepare(
      `INSERT INTO asset_class (symbol, asset_class, rule_hit, source, updated_by)
        VALUES ('sh510300', 'cash', 'default', 'manual', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO asset_class (symbol, asset_class, rule_hit, source, updated_by)
        VALUES ('sh511990', 'cash', 'cash_etf_name', 'rule', NULL)`,
    ).run();
    const c = selectClassifyCandidates(db);
    expect(c.map((x) => x.symbol)).toEqual(['sh204001', 'sh512130']);
  });
});

describe('assetClassSync · runAssetClassSyncIfNeeded（调用点守卫，ADR-024 增量语义）', () => {
  let db: Database.Database;
  const ORIGINAL = process.env[ASSET_CLASS_SYNC_ENV];
  const log = { info: () => {}, warn: () => {} };
  beforeEach(() => {
    db = makeDb();
    seedBusiness(db);
  });
  afterEach(() => {
    db.close();
    if (ORIGINAL === undefined) delete process.env[ASSET_CLASS_SYNC_ENV];
    else process.env[ASSET_CLASS_SYNC_ENV] = ORIGINAL;
  });

  it('默认（未设开关）⇒ dry-run：记日志但不写库', async () => {
    delete process.env[ASSET_CLASS_SYNC_ENV];
    const r = await runAssetClassSyncIfNeeded(db, log, { provider });
    expect(r?.mode).toBe('dry-run');
    expect(count(db)).toBe(0);
  });

  it('开关=off ⇒ 直接返回 null', async () => {
    process.env[ASSET_CLASS_SYNC_ENV] = 'off';
    expect(await runAssetClassSyncIfNeeded(db, log, { provider })).toBeNull();
  });

  it('全业务标的已有定论（rule 终态/default 冷却期内）⇒ 无候选 ⇒ 返回 null（不扫行情层）', async () => {
    await syncAssetClass(db, 'execute', provider); // 4 条 rule 行（2 终态 + 2 default，updated_at=now）
    process.env[ASSET_CLASS_SYNC_ENV] = 'execute';
    expect(await runAssetClassSyncIfNeeded(db, log, { provider })).toBeNull();
    expect(count(db)).toBe(4);
  });

  it('出现新业务标的（表中无行）⇒ 即使已有定论记录也会补判（旧版此处漏判）', async () => {
    // 4 个旧标的已有定论（直接 INSERT asset_class，不经过 syncAssetClass，避免把 sh511880 也写了）
    db.prepare(
      `INSERT INTO asset_class (symbol, asset_class, rule_hit, source) VALUES ('sh204001','cash','repo_code','rule')`,
    ).run();
    db.prepare(
      `INSERT INTO asset_class (symbol, asset_class, rule_hit, source) VALUES ('sh511990','cash','cash_etf_name','rule')`,
    ).run();
    db.prepare(
      `INSERT INTO asset_class (symbol, asset_class, rule_hit, source) VALUES ('sh510300','risk','default','rule')`,
    ).run();
    db.prepare(
      `INSERT INTO asset_class (symbol, asset_class, rule_hit, source) VALUES ('sh512130','risk','default','rule')`,
    ).run();
    // 新标的：业务层出现但 asset_class 无行
    db.prepare(`INSERT INTO user_trade_record (user_id, asset_code) VALUES (1, 'sh511880')`).run();
    process.env[ASSET_CLASS_SYNC_ENV] = 'execute';
    const r = await runAssetClassSyncIfNeeded(db, log, {
      provider: async (codes: string[]) =>
        codes.map((c) => (c === 'sh511880' ? MEASURED.sh511880 : { code: c })),
    });
    // 候选只有 sh511880（其余 4 个：sh204001/sh511990 终态 skip，sh510300/sh512130 冷却期内 skip）
    expect(r?.writtenCount).toBe(1);
    expect(r?.rows.map((x) => x.symbol)).toEqual(['sh511880']);
    expect(count(db)).toBe(5);
  });

  it('开关=execute ⇒ 落库（新候选全写）', async () => {
    process.env[ASSET_CLASS_SYNC_ENV] = 'execute';
    const r = await runAssetClassSyncIfNeeded(db, log, { provider });
    expect(r?.writtenCount).toBe(4);
    expect(count(db)).toBe(4);
  });
});
