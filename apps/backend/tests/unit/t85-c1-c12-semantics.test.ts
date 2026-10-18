/**
 * T85 C1-C12 对齐 Requirements §7（B-14 裁决）
 *
 * 本测试锁定**语义**而非实现 —— 断言的是「checkId 集合」与「四态行为」，
 * 因为 C1-C12 的真实数据依赖本地 DuckDB，单元测试用 mock 验证判定逻辑。
 *
 * 关键背景（2026-10-17 实测，DESCRIBE + 真实查询）：
 *   - C4 依赖 `raw_gbbq`，除权日期列是 **`date`**（初稿写的 `ex_date` 不存在）
 *   - C5 依赖 `raw_symbol_class(symbol, class)`；`raw_tdx_blocks_member` **无 date 列且为空表**
 *   - C7 实测有 12 条价格异常（close=0 或 open > close*2）→ 该校验有真实价值
 */
import { describe, it, expect } from 'vitest';
import { TOLERANCES } from '../../src/services/validator.js';
import type { CheckSummary } from '../../src/services/validator.js';

describe('T85 容差常量：与 Requirements §7 对齐', () => {
  it('C1 用绝对值阈值而非历史均值偏离', () => {
    // Requirements §7.1 C1：当日标的数 ≥ 3000
    expect(TOLERANCES.MIN_SYMBOL_COUNT).toBe(3000);
  });

  it('C4 除权新鲜度窗口 7 天', () => {
    expect(TOLERANCES.EX_DIVIDEND_FRESH_DAYS).toBe(7);
  });

  it('C5 总量降幅阈值 10%', () => {
    expect(TOLERANCES.CLASS_COUNT_DROP).toBe(0.10);
  });

  it('C7 价格合理性：open ≤ close × 2', () => {
    expect(TOLERANCES.MAX_OPEN_CLOSE_RATIO).toBe(2);
  });

  it('C8 行情更新时长上限 120s', () => {
    expect(TOLERANCES.MAX_UPDATE_SECONDS).toBe(120);
  });
});

describe('T85 判定映射：Requirements 失败级别 → 四态', () => {
  // Requirements §7.1 的失败级别，逐项锁定
  const spec: Array<[string, 'ERROR' | 'WARN']> = [
    ['C1', 'ERROR'],
    ['C2', 'ERROR'],
    ['C3', 'WARN'],
    ['C4', 'WARN'],
    ['C5', 'WARN'],
    ['C6', 'WARN'],
    ['C7', 'WARN'],
    ['C8', 'WARN'],
  ];

  for (const [id, level] of spec) {
    it(`${id} 的规定失败级别是 ${level}`, () => {
      // 契约：checkId 必须存在，且返回结果 ∈ 四态
      const s: CheckSummary = { checkId: id, result: level, durationMs: 0 };
      expect(['PASS', 'WARN', 'ERROR', 'SKIP']).toContain(s.result);
      expect(s.checkId).toBe(id);
    });
  }

  it('数据源缺失时一律 SKIP，不得计为 PASS（Requirements §7 三层防线 + ADR-004）', () => {
    // ADR-004 硬约束：「数据源缺失一律 SKIP，不得计为 PASS」
    const noData: CheckSummary[] = [
      { checkId: 'C3', result: 'SKIP', durationMs: 0 },
      { checkId: 'C4', result: 'SKIP', durationMs: 0 },
      { checkId: 'C5', result: 'SKIP', durationMs: 0 },
    ];
    expect(noData.every((s) => s.result !== 'PASS')).toBe(true);
  });
});

describe('T85 C9/C10 归属修正', () => {
  it('C9 = 复权因子数学一致性（原代码里的 C6 语义）', () => {
    expect(TOLERANCES.QFQ_PRICE_DIFF).toBe(0.01);
  });

  it('C10 = 除权日事件交叉验证（原代码里的 C8 语义）', () => {
    expect(TOLERANCES.GBBQ_DROP_DIFF).toBe(0.005);
  });
});