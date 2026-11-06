import { afterAll, describe, expect, it } from 'vitest';
import { closeDuckDBInstance, queryDuckDBColumnar } from '../../src/db/duckdb.js';

/**
 * 回归：`queryDuckDBColumnar` 的 **0 行结果**崩溃（2026-11-06 PR #91 CI 实测）
 *
 * 修复前表现：`SELECT 1 AS ok WHERE FALSE` 抛
 *   `Cannot read properties of undefined (reading 'length')`
 * —— 0 行时驱动给出的列向量是 `undefined`，但列名仍出现在 `columnNames()`。
 *
 * 为什么必须修（对 M1 的影响）：M1 的 `getBars` 是 M2/M3 引擎的唯一取数入口，
 * 一旦查到「窗口内没有任何 bar」的标的（未上市 / 已退市 / 整段停牌）就会崩，
 * 而这类输入正是停牌判定形态①（缺 bar）要覆盖的。
 *
 * 刻意不依赖任何真实表 ⇒ CI 的 12KB 空壳行情库也能跑
 * （与 `duckdbLeak.test.ts` 同一策略）。
 */
afterAll(async () => {
  await closeDuckDBInstance();
});

describe('queryDuckDBColumnar · 0 行结果', () => {
  it('0 行查询返回空列，而不是抛 TypeError', async () => {
    const res = await queryDuckDBColumnar('SELECT 1 AS ok WHERE FALSE');
    expect(res.names).toEqual(['ok']);
    expect(res.column('ok')).toEqual([]);
  });

  it('0 行时列名完整，逐列取都为空（含 DATE 列）', async () => {
    const res = await queryDuckDBColumnar(`SELECT 1 AS a, DATE '2026-10-12' AS d WHERE FALSE`);
    expect(res.names).toEqual(['a', 'd']);
    expect(res.column('a')).toEqual([]);
    expect(res.column('d')).toEqual([]);
  });

  it('有行时行为不变（1 行仍是 1 行）', async () => {
    const res = await queryDuckDBColumnar('SELECT 1 AS ok');
    expect(res.column('ok')).toEqual([1]);
  });
});
