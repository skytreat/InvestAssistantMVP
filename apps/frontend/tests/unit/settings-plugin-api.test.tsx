import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import Settings from '../../src/pages/Settings';
import { renderWithRouter, mockResponse } from '../helpers';

/**
 * 设置页插件区 —— **HTTP 方法契约**回归测试（Wave 8 缺陷 ①）
 *
 * 🔴 **缺陷 ①（用户可见 bug）**：设置页的插件「启用 / 禁用」开关与「保存参数」按钮
 *   此前都发的是 **`POST`** `/api/strategy/plugins/:id/{toggle,config}`，
 *   而后端**只注册了 `PUT`**（SDD §4.4）—— Fastify **不做方法回退**
 *   ⇒ 按钮**点了必然 404**，插件配置功能整体不可达。
 *
 * ⇒ 本文件把「必须用 PUT」钉成前端用例：
 *   ① 切换开关 → 断言 `api.put` 被调用，且 URL / body 正确；
 *   ② 保存参数 → 断言 `api.put` 被调用；
 *   ③ **断言 `api.post` 一次都没被调用**（防回退）。
 *
 * ⚠️ `api/client` 被 `vi.mock` 整模块替换 ⇒ 本文件自己提供 `put` / `post` 桩。
 */

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock, putMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock, put: putMock, post: postMock } }));

/** 一个最小可用的插件条目 */
const PLUGIN = {
  id: 'rsi_oversold',
  name: 'RSI 超卖监控',
  category: 'monitor',
  description: 'RSI 低于阈值时给出监控信号',
  paramSchema: [{ key: 'period', label: 'RSI 周期', type: 'number', default: 14 }],
  enabled: 1,
  params: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(mockResponse([PLUGIN]));
  putMock.mockResolvedValue(mockResponse(null));
  postMock.mockResolvedValue(mockResponse(null));
});

describe('设置页 · 插件启停必须走 PUT（缺陷 ① 回归）', () => {
  it('切换「已启用」开关 → 调用 api.put(/strategy/plugins/:id/toggle)，且不再调用 post', async () => {
    renderWithRouter(<Settings />);

    const checkbox = await screen.findByRole('checkbox');
    await waitFor(() => expect(getMock).toHaveBeenCalled());

    fireEvent.click(checkbox);

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [url, body] = putMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/strategy/plugins/rsi_oversold/toggle');
    // 插件当前是「已启用」(enabled=1) ⇒ 切换后应传 0
    expect(body).toEqual({ enabled: 0 });

    // 🔴 关键断言：一次 POST 都不能有（后端没有 POST 路由 ⇒ POST 必然 404）
    expect(postMock).not.toHaveBeenCalled();
  });

  it('保存插件参数 → 调用 api.put(/strategy/plugins/:id/config)，且不再调用 post', async () => {
    renderWithRouter(<Settings />);

    await screen.findByRole('checkbox');
    await waitFor(() => expect(getMock).toHaveBeenCalled());

    // 展开参数表单
    fireEvent.click(screen.getByRole('button', { name: '参数配置' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [url, body] = putMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/strategy/plugins/rsi_oversold/config');
    expect(body).toEqual({ params: { period: 14 } });

    expect(postMock).not.toHaveBeenCalled();
  });
});
