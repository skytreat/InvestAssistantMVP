import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIntegrationTest, createTestApp, type TestAppBundle } from './_helpers.js';
import { marketDataAvailable } from '../_marketData.js';

const HAS_MARKET = await marketDataAvailable();
// ⚠️ 下文的 `it.skipIf(!HAS_MARKET)` **不是静默跳过**：日常套件 `tests/setup.ts`
// 强制 `MARKET_DATA_MODE=ci`，会在每次运行时现生成迷你行情库 ⇒ CI 中这两条真实执行。

/**
 * F4 Step B —— `/api/strategy/effectiveness` + `/export` 集成测试
 *
 * ⚠️ 业务库现状只有 3 条信号，**任何输出都不得出现百分比结论** ——
 * 这里刻意造 21 条合成信号，只为验证「接口口径与装配」，不代表真实策略表现。
 * 断言里只校验结构 / 费率标识 / 样本门槛，不把胜率数字当业务结论。
 */
describe('F4 Step B · 策略有效性接口', () => {
  let bundle: TestAppBundle;

  beforeAll(async () => {
    bundle = await createTestApp();
  });

  afterAll(async () => {
    await bundle.app.close();
    cleanupIntegrationTest();
  });

  it('未登录 → 401', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/strategy/effectiveness' });
    expect(res.statusCode).toBe(401);
  });

  it('非法参数 → 400（horizon / group_by / 日期 / 本金）', async () => {
    const auth = { authorization: `Bearer ${bundle.adminToken}` };
    const cases = [
      '?horizon=t7',
      '?group_by=random',
      '?from=2026-13-01&to=2026-01-01',
      '?from=2026-02-01&to=2026-01-01',
      '?notional=0',
      '?benchmark=bad',
    ];
    for (const qs of cases) {
      const res = await bundle.app.inject({
        method: 'GET',
        url: `/api/strategy/effectiveness${qs}`,
        headers: auth,
      });
      expect(res.statusCode, qs).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error?.code ?? body.code).toBeTruthy();
    }
  });

  // 见文件顶部说明：CI 走 `MARKET_DATA_MODE=ci` 现生成迷你库，此用例真实执行。
  it.skipIf(!HAS_MARKET)('21 条合成信号：返回 meta 费率口径、样本充足时输出统计，明细带费率', async () => {
    // 用真实存在的交易日（迷你库），确保入场/出场窗口有 bar
    const { queryDuckDB } = await import('../../src/db/duckdb.js');
    const rows = (await queryDuckDB<{ date: string }>(
      `SELECT date FROM raw_kline_daily WHERE symbol = 'sh510300' ORDER BY date ASC LIMIT 40`,
    )) as Array<{ date: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(25);

    const dates = rows.slice(0, 21).map((r) => String(r.date).slice(0, 10));
    const insert = bundle.db.db.prepare(
      `INSERT OR IGNORE INTO user_strategy_signal
           (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, grade, origin)
         VALUES (?, 'sh510300', 'rsi_oversold', 'monitor', ?, 'buy', '测试信号', 'medium', 'replay')`,
    );
    for (const d of dates) insert.run(bundle.userId, d);

    const from = dates[0];
    const to = dates[dates.length - 1];
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/strategy/effectiveness?from=${from}&to=${to}&group_by=plugin&horizon=t5`,
      headers: { authorization: `Bearer ${bundle.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const report = JSON.parse(res.body).data;

    expect(report.meta.benchmark).toBe('sh510300');
    expect(report.meta.notional).toBe(50_000);
    expect(report.meta.feeModelLabel).toContain('ETF 口径（印花税 0 / 过户费 0）');
    expect(report.meta.fees.stampDutyRate).toBe(0);
    expect(report.meta.sampleSize).toBe(21);
    expect(report.meta.insufficientSample).toBe(false);
    expect(report.summary[0].winRateAbsolute).toBeTypeOf('number');
    expect(report.groups[0].stats[0].sampleSize).toBe(21);

    const detail = report.details[0];
    expect(detail.fees.transferFeeRate).toBe(0);
    expect(detail.fees.slippageRate).toBe(0.0001);
    expect(detail.feeModelLabel).toContain('ETF 口径');
  });

  // 见文件顶部说明：CI 走 `MARKET_DATA_MODE=ci` 现生成迷你库，此用例真实执行。
  it.skipIf(!HAS_MARKET)('CSV 导出：BOM + CRLF + 每行费率列', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/strategy/effectiveness/export?level=summary&horizon=t5',
      headers: { authorization: `Bearer ${bundle.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body.startsWith('\uFEFF')).toBe(true);
    expect(res.body).toContain('\r\n');
    expect(res.body).toContain('fee_model_label');
    expect(res.body).toContain('stamp_duty_rate');
    expect(res.body).toContain('ETF 口径（印花税 0 / 过户费 0）');
  });
});
