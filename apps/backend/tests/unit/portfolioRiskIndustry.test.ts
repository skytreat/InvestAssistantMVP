import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { queryDuckDB } = vi.hoisted(() => ({ queryDuckDB: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB }));

import { loadIndustryMapping } from '../../src/services/portfolioRisk.js';

/**
 * `loadIndustryMapping` 的取数口径（2026-11-06 真实库实测）：
 * - `block_type` 默认 `tdx_research`；
 * - 成员查询必须带 `i.block_level = 1`，否则同一标的三级挂靠会让占比放大 2.85 倍；
 * - 降级只看数据（类型为空 / 成员为空）。
 */
describe('loadIndustryMapping 取数口径', () => {
  beforeEach(() => {
    queryDuckDB.mockReset();
    delete process.env.INDUSTRY_BLOCK_TYPES;
    delete process.env.INDUSTRY_BLOCK_LEVEL;
  });

  // 跨文件隔离：这两个键不在 setup.ts 的守卫范围，必须由本文件自己清干净
  afterEach(() => {
    delete process.env.INDUSTRY_BLOCK_TYPES;
    delete process.env.INDUSTRY_BLOCK_LEVEL;
  });

  it('成员查询带 block_level=1，且默认 type 为 tdx_research', async () => {
    queryDuckDB
      .mockResolvedValueOnce([{ block_type: 'tdx_research' }, { block_type: 'concept' }])
      .mockResolvedValueOnce([{ stock_symbol: 'sh600000', block_name: '银行' }]);

    const r = await loadIndustryMapping(['sh600000']);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.types).toEqual(['tdx_research']);

    const sql = String(queryDuckDB.mock.calls[1]?.[0] ?? '');
    expect(sql).toContain('i.block_level = ?');
    expect(queryDuckDB.mock.calls[1]?.[1]).toEqual(['sh600000', 'tdx_research', 1]);
  });

  it('INDUSTRY_BLOCK_LEVEL 覆盖层级参数', async () => {
    process.env.INDUSTRY_BLOCK_LEVEL = '2';
    queryDuckDB
      .mockResolvedValueOnce([{ block_type: 'tdx_research' }])
      .mockResolvedValueOnce([{ stock_symbol: 'sh600000', block_name: '煤炭开采' }]);

    await loadIndustryMapping(['sh600000']);

    expect(queryDuckDB.mock.calls[1]?.[1]).toEqual(['sh600000', 'tdx_research', 2]);
  });

  it('信息表无 block_type → empty（降级，不查成员表）', async () => {
    queryDuckDB.mockResolvedValueOnce([]);
    const r = await loadIndustryMapping(['sh600000']);
    expect(r).toMatchObject({ ok: false, reason: 'empty' });
    expect(queryDuckDB).toHaveBeenCalledTimes(1);
  });

  it('类型无法识别为行业 → unrecognized', async () => {
    queryDuckDB.mockResolvedValueOnce([{ block_type: 'concept' }, { block_type: 'style' }]);
    const r = await loadIndustryMapping(['sh600000']);
    expect(r).toMatchObject({ ok: false, reason: 'unrecognized' });
  });

  it('类型存在但成员表无成分 → no-member（不输出全「未分类」的假分布）', async () => {
    queryDuckDB.mockResolvedValueOnce([{ block_type: 'tdx_research' }]).mockResolvedValueOnce([]);
    const r = await loadIndustryMapping(['sh512400']);
    expect(r).toMatchObject({ ok: false, reason: 'no-member' });
  });

  it('同一标的多个 L1 板块 → 按板块名取首个', async () => {
    queryDuckDB.mockResolvedValueOnce([{ block_type: 'tdx_research' }]).mockResolvedValueOnce([
      { stock_symbol: 'sh600000', block_name: '银行' },
      { stock_symbol: 'sh600000', block_name: '多元金融' },
    ]);
    const r = await loadIndustryMapping(['sh600000']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.map.get('sh600000')).toBe('多元金融'); // 名称升序第一个
  });
});
