/**
 * symbolSearch.test.ts — T136 标的联想回归
 *
 * 回归目标：`symbol_dict` 之前只有 INSERT/SELECT、没有 DDL，导致全新库上
 * `GET /api/symbols/search` 直接 500 `no such table: symbol_dict`。
 *
 * 覆盖：
 *   - 启动时创建 symbol_dict + 两个索引（SDD_v3 §11.1.4）
 *   - 精确 6 位返回完整 symbol
 *   - 拼音首字母 / 中文名子串命中
 *   - 无匹配返回 200 + 空数组，**不回退 DuckDB**（避免每次空结果都打开行情库）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;

const PUFA = {
  symbol: 'sh600000',
  code6: '600000',
  name: '浦发银行',
  pinyin: 'pfyh',
  market: 'sh',
  class: 'stock',
  asset_class: 'risk',
};

const CASH_ETF = {
  symbol: 'sh511990',
  code6: '511990',
  name: '华宝添益',
  pinyin: 'hbty',
  market: 'sh',
  class: 'etf',
  asset_class: 'cash',
};

function seed(
  row: Pick<typeof PUFA, 'symbol' | 'code6' | 'name' | 'pinyin' | 'market' | 'asset_class'>,
): void {
  bundle.db.db
    .prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, asset_class)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(row.symbol, row.code6, row.name, row.pinyin, row.market, row.asset_class);
}

async function search(q: string) {
  const res = await bundle.app.inject({
    method: 'GET',
    url: `/api/symbols/search?q=${encodeURIComponent(q)}`,
    headers: { authorization: `Bearer ${bundle.adminToken}` },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

beforeAll(async () => {
  bundle = await createTestApp();
  seed(PUFA);
  seed(CASH_ETF);
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
});

describe('GET /api/symbols/search', () => {
  it('启动时已创建 symbol_dict 与查询索引', () => {
    const table = bundle.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_dict'")
      .get();
    expect(table).toBeTruthy();

    const indexes = (
      bundle.db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='symbol_dict'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_symbol_dict_code6', 'idx_symbol_dict_pinyin']));
  });

  it('精确 6 位 → 返回完整代码 + 名称 + 拼音', async () => {
    const { status, body } = await search('600000');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      symbol: 'sh600000',
      code6: '600000',
      name: '浦发银行',
      pinyin: 'pfyh',
      asset_class: 'risk',
    });
  });

  it('拼音首字母 / 中文名子串可命中', async () => {
    const byPinyin = await search('pfyh');
    expect(byPinyin.status).toBe(200);
    expect(byPinyin.body.data.map((r: { symbol: string }) => r.symbol)).toContain('sh600000');

    const byName = await search('浦发');
    expect(byName.status).toBe(200);
    expect(byName.body.data.map((r: { symbol: string }) => r.symbol)).toContain('sh600000');
  });

  it('现金类标的返回 asset_class=cash', async () => {
    const { status, body } = await search('511990');
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ symbol: 'sh511990', asset_class: 'cash' });
  });

  it('无匹配 → 200 + 空数组（不回退 DuckDB）', async () => {
    const { status, body } = await search('999999');
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });
});
