/**
 * DatacheckCards —— C1-C12 校验仪表盘用例（Wave 7 · 卡 3）
 *
 * 对应任务卡：`docs/audit/wave-7-task-cards.md` 卡 3。
 *
 * ## 这个文件守的是 G7.6 的三个子句
 *
 * 1. 「12 项校验卡片**真实渲染 12 条**（不再是空态 / `checkId` 只有 2 个）」
 * 2. 「卡片显示的**校验名称**与 SDD §5.7 主表一致」—— 名称由后端下发，前端只渲染
 * 3. 「停牌/退市/ST 等扩展校验**不得占用 C 编号**」
 *
 * ⚠️ **名称不在本文件里写死成「期望值」** —— 本文件断言的是
 *   「卡片上渲染出来的名称 = 后端给的名称」，而「后端给的名称 = SDD §5.7 标题」
 *   由后端用例 `apps/backend/tests/unit/datacheck-names.test.ts` 逐字锁死。
 *   两边合起来才是 G7.6 的完整证明；任何一边单独立都不足以证明「与 SDD 一致」。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import DatacheckCards from '../../src/components/DatacheckCards';
import { mockResponse } from '../helpers';
import { COLORS } from '../../src/theme/tokens';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: unknown) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

interface ItemFixture {
  checkId: string;
  name: string;
  result: string;
  message: string;
  detail: string | null;
}

/** 12 项完整结果（名称取自后端契约，前端只负责渲染） */
const FULL_ITEMS: ItemFixture[] = [
  { checkId: 'C1', name: '当日日线行数是否正常', result: 'PASS', message: 'C1 PASS', detail: null },
  { checkId: 'C2', name: '交易日历匹配', result: 'PASS', message: 'C2 PASS', detail: null },
  { checkId: 'C3', name: '复权因子数据新鲜度', result: 'WARN', message: 'C3 WARN', detail: '因子滞后 1 天' },
  { checkId: 'C4', name: '除权除息数据新鲜度', result: 'PASS', message: 'C4 PASS', detail: null },
  { checkId: 'C5', name: '板块 / 概念数据完整性', result: 'PASS', message: 'C5 PASS', detail: null },
  { checkId: 'C6', name: '市值数据存在性', result: 'ERROR', message: 'C6 ERROR', detail: '市值表 0 行' },
  { checkId: 'C7', name: '日线价格合理性', result: 'PASS', message: 'C7 PASS', detail: null },
  { checkId: 'C8', name: '行情更新执行时长', result: 'PASS', message: 'C8 PASS', detail: null },
  { checkId: 'C9', name: '复权因子抽样数学一致性', result: 'PASS', message: 'C9 PASS', detail: null },
  { checkId: 'C10', name: '除权除息事件覆盖完整性', result: 'PASS', message: 'C10 PASS', detail: null },
  {
    checkId: 'C11',
    name: 'Tushare 免费 API 跨源校验（每日 1 次）',
    result: 'SKIP',
    message: 'C11 SKIP',
    detail: null,
  },
  {
    checkId: 'C12',
    name: '东财跨源校验（20 只抽样，节流）',
    result: 'SKIP',
    message: 'C12 SKIP',
    detail: null,
  },
];

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue(mockResponse(FULL_ITEMS));
});

/**
 * hex → `rgb(r, g, b)`
 *
 * ⚠️ jsdom 会把内联样式里的 hex **规范化**成 `rgb()` 形式
 *   （`style.background` 返回 `'rgb(220, 252, 231)'` 而不是 `'#dcfce7'`），
 *   ⇒ 断言颜色必须先过这个转换，否则会假红。
 */
function toRgb(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/** WCAG 2.1 相对亮度 */
function relativeLuminance(rgb: string): number {
  const parts = rgb.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
  const [r, g, b] = parts;
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 对比度 */
function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('校验卡片：12 张 + 名称 + 四色', () => {
  it('校验卡片：渲染 12 张且每张含 checkId 与校验名称', async () => {
    render(<DatacheckCards />);
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(12));

    const cards = screen.getAllByRole('button');
    for (const item of FULL_ITEMS) {
      const card = cards.find((el) => el.getAttribute('data-check-id') === item.checkId);
      expect(card).toBeDefined();
      // 卡片文本同时含编号与名称（G7.6「名称与 SDD §5.7 一致」的展示面）
      expect(within(card as HTMLElement).getByText(item.checkId)).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText(item.name)).toBeInTheDocument();
    }
  });

  it('校验卡片：点击展开详情 JSON（aria-expanded 切换）', async () => {
    const user = userEvent.setup();
    render(<DatacheckCards />);
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(12));

    const card = screen.getAllByRole('button').find((el) => el.getAttribute('data-check-id') === 'C3');
    expect(card).toBeDefined();
    expect(card?.getAttribute('aria-expanded')).toBe('false');

    await user.click(card as HTMLElement);

    expect(card?.getAttribute('aria-expanded')).toBe('true');
    // `aria-controls` 指向的详情区可见，且含 detail 原文
    const controls = card?.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const detail = screen.getByTestId(controls as string);
    expect(detail).toBeVisible();
    expect(detail).toHaveTextContent('因子滞后 1 天');
    expect(detail).toHaveTextContent('C3 WARN');

    // 再点一次收起
    await user.click(card as HTMLElement);
    expect(card?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId(controls as string)).not.toBeVisible();
  });

  it('校验卡片：四色映射 PASS/WARN/ERROR/SKIP 互不相同', async () => {
    getMock.mockResolvedValue(
      mockResponse([
        { checkId: 'C1', name: '当日日线行数是否正常', result: 'PASS', message: 'ok', detail: null },
        { checkId: 'C2', name: '交易日历匹配', result: 'WARN', message: 'warn', detail: null },
        { checkId: 'C3', name: '复权因子数据新鲜度', result: 'ERROR', message: 'bad', detail: null },
        { checkId: 'C4', name: '除权除息数据新鲜度', result: 'SKIP', message: 'skip', detail: null },
      ]),
    );
    render(<DatacheckCards />);
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(12));

    const states = ['PASS', 'WARN', 'ERROR', 'SKIP'];
    const badges = states.map((state) => {
      const card = screen.getAllByRole('button').find((el) => el.getAttribute('data-result') === state);
      expect(card).toBeDefined();
      return screen.getByTestId(`datacheck-badge-${card?.getAttribute('data-check-id')}`);
    });

    // ① 四态的 data 属性互不相同（便于回归）
    const renderedStates = screen
      .getAllByRole('button')
      .map((el) => el.getAttribute('data-result'))
      .filter((s) => s !== null);
    expect(new Set(renderedStates).size).toBe(4);

    // ② 四色底色互不相同
    const backgrounds = badges.map((b) => (b as HTMLElement).style.background);
    expect(new Set(backgrounds).size).toBe(4);

    // ③ 四色文字互不相同，且**不得是白字**（旧实现是「彩色底 + 白字」→ 对比度不足）
    const colors = badges.map((b) => (b as HTMLElement).style.color);
    expect(new Set(colors).size).toBe(4);
    for (const color of colors) {
      expect(color).not.toBe(COLORS.cardBg);
    }
    // PASS 的徽标 = 绿（浅底 + 深绿字）
    expect((badges[0] as HTMLElement).style.background).toBe(toRgb(COLORS.bgPillSuccess));
    expect((badges[0] as HTMLElement).style.color).toBe(toRgb(COLORS.textPillSuccess));
  });

  it('校验卡片：后端少返回时仍占位 12 张（缺失项 SKIP + 未运行）', async () => {
    getMock.mockResolvedValue(
      mockResponse([
        { checkId: 'C1', name: '当日日线行数是否正常', result: 'PASS', message: 'C1 PASS', detail: null },
        { checkId: 'C2', name: '交易日历匹配', result: 'WARN', message: 'C2 WARN', detail: null },
      ]),
    );
    render(<DatacheckCards />);
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(12));

    // 缺项占位：SKIP + 「未运行」
    const c3 = screen.getAllByRole('button').find((el) => el.getAttribute('data-check-id') === 'C3');
    expect(c3?.getAttribute('data-result')).toBe('SKIP');
    expect(c3).toHaveTextContent('未运行');

    // 扩展校验（不占 C 编号）不得出现
    expect(screen.queryByText('C13')).toBeNull();
  });

  it('校验卡片：请求失败时显示错误提示且不弹窗', async () => {
    getMock.mockRejectedValue({
      response: { data: { code: 'FORBIDDEN', message: '无权限执行该操作' } },
    });
    render(<DatacheckCards />);
    await waitFor(() => expect(screen.getByText('无权限执行该操作')).toBeInTheDocument());
    // 失败也要保留 12 张占位卡（不得退回空态）
    expect(screen.getAllByRole('button')).toHaveLength(12);
  });

  it('校验卡片：四色的文字对比度均 ≥ 4.5:1（纯计算，真浏览器由 axe 兜底）', async () => {
    // ⚠️ **纯计算**（裁决 D-9）：axe 的 `color-contrast` 在 jsdom 下恒 incomplete，
    //   真浏览器那一层由 卡 6 的 `scripts/a11y-check.mjs` 负责；
    //   这里用 WCAG 2.1 相对亮度公式把「浅色底 + 深色字」的门槛**锁在 vitest 里**。
    const pairs: Array<[string, string, string]> = [
      // [状态, 徽标底色, 徽标文字色]
      ['PASS', COLORS.bgPillSuccess, COLORS.textPillSuccess],
      ['WARN', COLORS.bgPillWarning, COLORS.textPillWarning],
      ['ERROR', COLORS.bgPillDanger, COLORS.textPillDanger],
      ['SKIP', COLORS.bgPillNeutral, COLORS.textPillNeutral],
    ];
    for (const [state, bg, fg] of pairs) {
      const ratio = contrastRatio(toRgb(fg), toRgb(bg));
      expect(
        ratio,
        `${state} 徽标对比度 ${ratio.toFixed(2)}:1 < 4.5:1（bg=${bg} fg=${fg}）`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    // 🔴 **不得回到旧实现的「彩色底 + 白字」**（对比度不足的来源）
    for (const [state, bg, fg] of pairs) {
      expect(`${state}:${fg}`).not.toBe(`${state}:${COLORS.cardBg}`);
      expect(`${state}:${bg}`).not.toBe(`${state}:${COLORS.success}`);
    }
  });
});
