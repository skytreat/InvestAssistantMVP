/**
 * 注册/登录入口页的隐私声明用例（Wave 7 · 卡 6 · PRD §5.9）
 *
 * ## 为什么在 `/login` 页测
 *
 * PRD §5.9 逐字：「隐私声明常驻 | **注册页** + 设置页展示隐私声明：
 * 不收集手机号、位置、社交账号等多余个人信息；仅存储交易数据和行情相关数据」。
 *
 * ⚠️ 本前端的**唯一免鉴权页面**就是 `/login`（注册/登录入口页）——
 *   后端有 `POST /api/auth/register`（首个注册用户自动 admin），但前端**只有登录表单**。
 *   ⇒ PRD §5.9 要求「注册页展示隐私声明」落在本页面：用户**建号之前**就能看到声明。
 *   （设置页的那一份由 Wave 7 卡 5 落地，见 `tests/unit/settings-compliance.test.tsx`。）
 *
 * ⚠️ 断言的是**逐字要点**（不是「有个叫隐私声明的东西」）：
 *   「不收集手机号」「位置」「社交账号」「仅存储交易数据和行情相关数据」。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import React from 'react';
import Login from '../../src/pages/Login';
import { renderWithRouter } from '../helpers';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../../src/api/client', () => ({
  api: { get: vi.fn(), post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

beforeEach(() => {
  postMock.mockReset();
  postMock.mockResolvedValue({
    data: { code: 0, data: null, timestamp: '2026-10-21T00:00:00.000Z', success: true },
  });
});

describe('注册/登录入口页的隐私声明（PRD §5.9）', () => {
  it('登录/注册入口页：展示隐私声明（不收集手机号/位置/社交账号 + 仅存交易与行情数据）', () => {
    renderWithRouter(<Login />);

    const notice = screen.getByTestId('privacy-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('不收集手机号');
    expect(notice).toHaveTextContent('位置');
    expect(notice).toHaveTextContent('社交账号');
    expect(notice).toHaveTextContent('仅存储交易数据和行情相关数据');

    // 必须是**独立区块**（不是全局合规条里的一句）
    expect(screen.getByText('隐私声明')).toBeInTheDocument();
  });
});
