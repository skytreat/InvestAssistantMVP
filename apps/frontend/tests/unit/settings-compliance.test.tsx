import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import Settings from '../../src/pages/Settings';
import { COLORS } from '../../src/theme/tokens';

/**
 * 设置页合规文案 + token 对比度用例（Wave 7 · 卡 5 · T76 ⑥ / G3.4 遗留项）
 *
 * ## 覆盖的验收断言（卡 5「验收断言」A1 / A7 / A8）
 *
 * - A1：4 个（实为 5 个）正文 token 对白底对比度 **≥ 4.5**；
 *   纯计算可行（WCAG 相对亮度公式），**不依赖 axe**
 *   （axe 的 `color-contrast` 在 jsdom 恒 incomplete，见 `tests/helpers/a11y.ts`）；
 * - A7：设置页渲染 → 文本含「不收集手机号」「仅存储交易数据和行情相关数据」；
 * - A8：设置页**插件区**文本含「荐股」「资金托管」「实盘对接」「超时保护」。
 *
 * ## 对比度口径（卡 5「实测口径」）
 *
 * WCAG 2.1 相对亮度比 `(L1 + 0.05) / (L2 + 0.05)`，
 * 背景取 `COLORS.cardBg = #ffffff`（卡片底）**与** `COLORS.pageBg = #f8fafc`（页面底）
 * **两种都要 ≥ 4.5**（弱化文字在浅灰底上更差）。
 */

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock, post: postMock } }));

beforeEach(() => {
  getMock.mockResolvedValue({
    data: { code: 0, data: [], timestamp: '2026-10-21T00:00:00.000Z', success: true },
  });
  postMock.mockResolvedValue({
    data: { code: 0, data: null, timestamp: '2026-10-21T00:00:00.000Z', success: true },
  });
});

/* ------------------------------------------------------------------ *
 * 对比度计算（WCAG 2.1）
 * ------------------------------------------------------------------ */

/** sRGB 通道 → 线性化 */
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** 相对亮度 */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 对比度比 */
function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('设置页合规文案（PRD §5.9）', () => {
  it('设置页：展示隐私声明（不收集手机号/仅存交易与行情数据）', async () => {
    render(<Settings />);

    // 用 findBy 等待插件列表的异步加载结束（避免 act(...) 警告）
    const notice = await screen.findByTestId('privacy-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('不收集手机号');
    expect(notice).toHaveTextContent('位置');
    expect(notice).toHaveTextContent('社交账号');
    expect(notice).toHaveTextContent('仅存储交易数据和行情相关数据');
  });

  it('设置页：插件区展示插件安全承诺（禁荐股/资金托管/实盘对接/超时保护）', async () => {
    render(<Settings />);

    // 承诺必须落在**插件管理区域**内（不是页脚、也不是「关于」卡片）
    const notice = await screen.findByTestId('plugin-security-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('荐股');
    expect(notice).toHaveTextContent('资金托管');
    expect(notice).toHaveTextContent('实盘对接');
    expect(notice).toHaveTextContent('超时保护');
  });
});

describe('Token 对比度（Wave 7 卡 5 · 裁决 D-8 / D-9）', () => {
  it('Token 对比度：textMuted/textFaint/info/success 对白底均 ≥4.5:1', () => {
    /**
     * ⚠️ 这里断言的是**正文色档**（浅底上的文字）：
     *   `textMuted` / `textFaint`（弱化文字，就地加深）
     *   + `textSuccess` / `textInfo` / `textWarning`（语义色的正文档，新增）
     *
     * 饱和的 `COLORS.success` / `info` / `warning` 是**徽章/图形档**（D-8 保留原值），
     * 它们的正文用途一律改走正文色档 —— 见 `theme/tokens.ts` 的注释。
     */
    const bodyTokens: Record<string, string> = {
      textMuted: COLORS.textMuted,
      textFaint: COLORS.textFaint,
      textSuccess: COLORS.textSuccess,
      textInfo: COLORS.textInfo,
      textWarning: COLORS.textWarning,
    };

    for (const [name, value] of Object.entries(bodyTokens)) {
      const onWhite = contrastRatio(value, COLORS.cardBg);
      const onPage = contrastRatio(value, COLORS.pageBg);
      expect({ name, bg: 'white', ratio: onWhite }).toEqual({
        name,
        bg: 'white',
        ratio: expect.any(Number),
      });
      expect(onWhite).toBeGreaterThanOrEqual(4.5);
      expect(onPage).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('Token 对比度：徽章底色档不得承载白字（<4.5:1）', () => {
    /**
     * 反向断言：饱和的 `success` / `info` / `warning` 若被当徽章底色承载白字，
     * 对比度只有 3.30 / 3.68 / 3.19 —— 所以它们**只能**用于描边 / 色点 / 深色画布，
     * 徽章带文字必须改用「浅底 + 深字」或「正文色档作底 + 白字」。
     */
    for (const name of ['success', 'info', 'warning'] as const) {
      const ratio = contrastRatio(COLORS.cardBg, COLORS[name]);
      expect(ratio).toBeLessThan(4.5);
    }

    // 正文色档作底 + 白字 → 达标
    for (const name of ['textSuccess', 'textInfo', 'textWarning'] as const) {
      const ratio = contrastRatio(COLORS.cardBg, COLORS[name]);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });
});
