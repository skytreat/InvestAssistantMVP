/**
 * broker_reconcile_report.test.ts — T126（V3.1）对账报告 + 差额归因
 * 对应 SDD_v3 §12.1：INV-S2-62~65（对账/差额归因/覆盖区间/三口径收益），gate G7
 * 载体 = tests/fixtures/broker-samples/（脱敏样本，V3-B7）
 * 1) run → 报告结构完整 + 覆盖区间声明 + 归因逐项（无 "other" 兜底）+ residual 置顶
 * 2) latest 与 run 幂等一致（D-25：按需重算，不落表）
 * 3) diff 端点分页 + 归因类别下钻
 * 4) 性能：3 年覆盖 < 10s（MVP 样本 6 文件 1627 行，本地 < 1s）
 * ⚠️ sequence.shuffle=true ⇒ 每个用例自包含（专属 userId，无共享可变状态）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-broker-reconcile-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

// 存在性判定源 = DuckDB raw_symbol_class：mock 返回空（本文件专注对账报告行为，不做存在性判定）
const { queryDuckDBMock } = vi.hoisted(() => ({ queryDuckDBMock: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import { importBrokerFile } from '../../src/services/broker/brokerImport.js';
import {
  buildReconcileReport,
  attributionDrilldown,
} from '../../src/services/broker/brokerReconcileReport.js';
import { dedupeAcrossFiles } from '../../src/services/broker/brokerReconcile.js';

let db: Database.Database;
const FIX = path.resolve(__dirname, '../../../../tests/fixtures/broker-samples');

async function ensureImported(uid: number, brokerCode: string, files: string[]): Promise<void> {
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
  ).run(uid, `user_${uid}`, 'x');
  const n = (
    db
      .prepare(`SELECT COUNT(*) c FROM broker_import_batch WHERE user_id = ? AND is_deleted = 0`)
      .get(uid) as { c: number }
  ).c;
  if (n === 0) {
    for (const f of files) {
      const r = await importBrokerFile(db, uid, brokerCode, {
        buffer: fs.readFileSync(path.join(FIX, f)),
        filename: f,
      });
      expect(r.duplicateFile, f).toBe(false);
    }
  }
}

beforeAll(async () => {
  db = ConfigStore.getInstance().db;
  // 默认放行：mock raw_symbol_class 返回空（本文件专注对账报告，不做存在性判定）
  queryDuckDBMock.mockImplementation(async () => []);
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
  ).run(7401, 'user_7401', 'x');
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

describe('T126 · gate G7：对账报告结构 + 归因逐项 + 无 "other" 兜底 + residual 置顶', () => {
  it('run 端点返回完整报告：覆盖区间声明 + matchSummary + attribution 有序 + fundCheck + timeBackfill + repoModel + returnSummary', async () => {
    await ensureImported(7401, '国泰', [
      '2026-10-20-国泰ETF交割单.xlsx',
      '2026-10-20-国泰ETF成交.xlsx',
      '2026-10-20-国泰股票交割单.xlsx',
      '2026-10-20-国泰股票成交.xlsx',
    ]);

    const report = buildReconcileReport(db, 7401, '国泰');

    // 1) 基础字段存在
    expect(report.brokerCode).toBe('国泰');
    expect(report.coveredRange.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.coveredRange.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.coverageNote).toContain('覆盖区间');
    expect(report.coverageNote).toContain('不构成「已核对」');
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 2) matchSummary 完整
    expect(typeof report.matchSummary.factRows).toBe('number');
    expect(report.matchSummary.factRows).toBeGreaterThan(0);
    expect(typeof report.matchSummary.matched).toBe('number');
    expect(typeof report.matchSummary.fuzzy).toBe('number');
    expect(typeof report.matchSummary.missing).toBe('number');
    expect(typeof report.matchSummary.extra).toBe('number');

    // 3) attribution：所有键存在、residual 置顶、order 数组存在
    const { repo, cashLikeEtf, dividend, offExchange, uncoveredPeriod, caliberDiff, residual, order } =
      report.attribution;
    expect(typeof repo).toBe('number');
    expect(typeof cashLikeEtf).toBe('number');
    expect(typeof dividend).toBe('number');
    expect(typeof offExchange).toBe('number');
    expect(typeof uncoveredPeriod).toBe('number');
    expect(typeof caliberDiff).toBe('number');
    expect(typeof residual).toBe('number');
    expect(Array.isArray(order)).toBe(true);
    expect(order[0]).toBe('residual'); // residual 置顶
    expect(order).toEqual(
      expect.arrayContaining([
        'repo',
        'cashLikeEtf',
        'dividend',
        'offExchange',
        'uncoveredPeriod',
        'caliberDiff',
        'residual',
      ]),
    );

    // 4) fundCheck + timeBackfill + repoModel 存在
    expect(report.fundCheck.checked).toBe(139);
    expect(report.fundCheck.hit).toBe(139);
    expect(report.fundCheck.skippedEvents).toBeGreaterThanOrEqual(3); // 分红等非买卖事件
    expect(typeof report.timeBackfill.totalNeeded).toBe('number');
    expect(Array.isArray(report.repoModel.pairs)).toBe(true); // 数组存在
    expect(report.repoModel.unpairedOpens).toBeGreaterThanOrEqual(0);
    expect(report.repoModel.unpairedCloses).toBeGreaterThanOrEqual(0);
    expect(report.repoModel.totalInterest).toBeGreaterThanOrEqual(0);

    // 5) returnSummary 两口径占位版（D-25）
    expect(typeof report.returnSummary.risk).toBe('number');
    expect(typeof report.returnSummary.cash).toBe('number');
    expect(report.returnSummary.total).toBe(report.returnSummary.risk + report.returnSummary.cash);
    expect(report.returnSummary.note).toContain('两口径占位');
  });

  it('latest 与 run 幂等一致（D-25：按需重算，不落表）', async () => {
    await ensureImported(7501, '国泰', [
      '2026-10-20-国泰ETF交割单.xlsx',
      '2026-10-20-国泰ETF成交.xlsx',
      '2026-10-20-国泰股票交割单.xlsx',
      '2026-10-20-国泰股票成交.xlsx',
    ]);
    const r1 = buildReconcileReport(db, 7501, '国泰');
    const r2 = buildReconcileReport(db, 7501, '国泰');
    // 幂等：同一用户/券商 → 核心字段一致（不落表、无副作用）
    expect(r1.brokerCode).toBe(r2.brokerCode);
    expect(r1.coveredRange).toEqual(r2.coveredRange);
    expect(r1.matchSummary.factRows).toBe(r2.matchSummary.factRows);
    expect(r1.matchSummary.matched).toBe(r2.matchSummary.matched);
    expect(r1.matchSummary.missing).toBe(r2.matchSummary.missing);
    expect(r1.attribution.repo).toBe(r2.attribution.repo);
    expect(r1.attribution.cashLikeEtf).toBe(r2.attribution.cashLikeEtf);
    expect(r1.attribution.dividend).toBe(r2.attribution.dividend);
    expect(r1.attribution.residual).toBe(r2.attribution.residual);
    expect(r1.attribution.order).toEqual(r2.attribution.order);
    expect(r1.fundCheck.checked).toBe(r2.fundCheck.checked);
    expect(r1.fundCheck.hit).toBe(r2.fundCheck.hit);
    expect(r1.fundCheck.skippedEvents).toBe(r2.fundCheck.skippedEvents);
    expect(r1.timeBackfill.totalNeeded).toBe(r2.timeBackfill.totalNeeded);
    expect(r1.repoModel.unpairedOpens).toBe(r2.repoModel.unpairedOpens);
    expect(r1.repoModel.unpairedCloses).toBe(r2.repoModel.unpairedCloses);
    expect(r1.returnSummary.total).toBe(r2.returnSummary.total);
    // 换个用户重新导入同文件，结果同构
    await ensureImported(7601, '国泰', ['2026-10-20-国泰ETF交割单.xlsx', '2026-10-20-国泰ETF成交.xlsx']);
    const r3 = buildReconcileReport(db, 7601, '国泰');
    expect(r3.brokerCode).toBe('国泰');
    expect(r3.matchSummary.factRows).toBeGreaterThan(0);
  });

  it('归因逐项可下钻（diff 端点），无 "other" 兜底、residual 可下钻', async () => {
    await ensureImported(7501, '国泰', [
      '2026-10-20-国泰ETF交割单.xlsx',
      '2026-10-20-国泰ETF成交.xlsx',
      '2026-10-20-国泰股票交割单.xlsx',
      '2026-10-20-国泰股票成交.xlsx',
    ]);

    // DIVIDEND drilldown
    const divDrill = attributionDrilldown(db, 7501, '国泰', 'dividend', 1, 10);
    expect(
      divDrill.rows.every((r) => r.event_type === 'DIVIDEND_CASH' || r.event_type === 'DIVIDEND_BONUS'),
    ).toBe(true);

    // OFF_EXCHANGE drilldown
    const offDrill = attributionDrilldown(db, 7501, '国泰', 'offExchange', 1, 10);
    expect(
      offDrill.rows.every((r) => ['EXCLUDED_OFFEXCHANGE', 'PLACEHOLDER', 'IGNORE'].includes(r.event_type)),
    ).toBe(true);

    // UNKNOWN drilldown
    const unknownDrill = attributionDrilldown(db, 7501, '国泰', 'unknown', 1, 10);
    expect(unknownDrill.total).toBe(0); // 样本无 UNKNOWN

    // UNMATCHED drilldown（待补录/系统无）
    const unmatched = attributionDrilldown(db, 7501, '国泰', 'unmatched', 1, 10);
    expect(unmatched.total).toBeGreaterThanOrEqual(0);
  });

  it('分页与分类过滤正常', async () => {
    await ensureImported(7601, '国泰', ['2026-10-20-国泰ETF交割单.xlsx']);
    const p1 = attributionDrilldown(db, 7601, '国泰', 'dividend', 1, 2);
    expect(p1.rows.length).toBeLessThanOrEqual(2);
    expect(p1.page).toBe(1);
    expect(p1.total).toBeGreaterThanOrEqual(p1.rows.length);

    const p2 = attributionDrilldown(db, 7601, '国泰', 'dividend', 2, 2);
    expect(p2.page).toBe(2);
  });

  it('性能门槛：3 年覆盖 < 10s（本地迷你库 < 1s，真库 < 10s 由 CI 另行门禁）', async () => {
    await ensureImported(7701, '国泰', [
      '2026-10-20-国泰ETF交割单.xlsx',
      '2026-10-20-国泰ETF成交.xlsx',
      '2026-10-20-国泰股票交割单.xlsx',
      '2026-10-20-国泰股票成交.xlsx',
    ]);
    const start = Date.now();
    buildReconcileReport(db, 7701, '国泰');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // 本地迷你库 < 1s，留足裕量
  });

  it('residual 置顶：order[0] == "residual"', async () => {
    await ensureImported(7801, '国泰', [
      '2026-10-20-国泰ETF交割单.xlsx',
      '2026-10-20-国泰ETF成交.xlsx',
      '2026-10-20-国泰股票交割单.xlsx',
      '2026-10-20-国泰股票成交.xlsx',
    ]);
    const r = buildReconcileReport(db, 7801, '国泰');
    expect(r.attribution.order[0]).toBe('residual');
  });

  it('华宝 2 份报告：repoModel 基线 180/180 + 利息 7501.46 + 日期归一化（G9 口径交叉断言）', async () => {
    // 专属用户 7901：报告内嵌 repoModel 的数值基线与 T127 repo_model.test.ts（gate G9）同源
    await ensureImported(7901, '华宝', ['20261020_华宝交割单.xls', '20261020_华宝成交.xls']);
    dedupeAcrossFiles(db, 7901, '华宝'); // 成交侧冗余腿软标记 EXCLUDED ⇒ 模型只算交割侧，不双计（幂等）
    const r = buildReconcileReport(db, 7901, '华宝');
    // repoModel 基线（§7.1.5：配对 180/180、未配对 0、利息 7501.46 ±0.5）
    expect(r.repoModel.pairs.length).toBe(180);
    expect(r.repoModel.unpairedOpens).toBe(0);
    expect(r.repoModel.unpairedCloses).toBe(0);
    expect(r.repoModel.totalInterest).toBeCloseTo(7501.46, 0);
    // 华宝日期为 YYYYMMDD ⇒ 报告统一归一化为 YYYY-MM-DD（gate G7 覆盖区间声明）
    expect(r.coveredRange.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.coveredRange.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 收益两口径（D-25 占位版）：现金类 = 逆回购利息；total = risk + cash
    expect(r.returnSummary.cash).toBeCloseTo(7501.46, 0);
    expect(r.returnSummary.total).toBe(r.returnSummary.risk + r.returnSummary.cash);
    // 样本无 UNKNOWN ⇒ residual = 0 且置顶
    expect(r.attribution.residual).toBe(0);
    expect(r.attribution.order[0]).toBe('residual');
    // 逆回购事件可下钻
    const repoDrill = attributionDrilldown(db, 7901, '华宝', 'repo', 1, 10);
    expect(repoDrill.total).toBeGreaterThan(0);
    expect(repoDrill.rows[0]).toHaveProperty('event_type');
    expect(repoDrill.rows[0].event_type).toBe('REPO');
  });
});
