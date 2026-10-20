import React from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * 前端测试公共 helper（T61）
 *
 * 组件大量使用 react-router 的 `useNavigate` / `Link` / `useSearchParams`，
 * 直接 `render()` 会抛「useNavigate() may be used only in the context of a <Router>」。
 * 故统一经本文件渲染，自动包一层 MemoryRouter。
 */

export interface RouterRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  /** 初始路由（MemoryRouter 的 initialEntries）*/
  initialEntries?: string[];
  /** 路由 basename */
  basename?: string;
}

/** 带 MemoryRouter 的 render —— 结果额外提供 `routerPath`（当前 location）*/
export function renderWithRouter(
  ui: React.ReactElement,
  options: RouterRenderOptions = {},
): RenderResult & { readonly routerPath: string } {
  const { initialEntries = ['/'], basename, ...rest } = options;
  const pathRef = { current: initialEntries[0] ?? '/' };

  function LocationSpy({ onChange }: { onChange: (p: string) => void }) {
    const location = useLocation();
    React.useEffect(() => {
      onChange(location.pathname + location.search);
    }, [location.pathname, location.search, onChange]);
    return null;
  }

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={initialEntries} basename={basename}>
        {children}
        <LocationSpy onChange={(p) => { pathRef.current = p; }} />
      </MemoryRouter>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...rest });

  return Object.defineProperty(result, 'routerPath', {
    get: () => pathRef.current,
    enumerable: true,
  }) as RenderResult & { readonly routerPath: string };
}

/** 造一个形如 axios 成功响应的替身（后端统一 envelope）*/
export function mockResponse<T>(data: T, extra?: Record<string, unknown>) {
  return {
    data: {
      code: 0,
      data,
      timestamp: '2026-10-20T00:00:00.000Z',
      success: true,
      ...(extra ?? {}),
    },
  };
}

/** 造一个形如 axios 错误响应的替身 */
export function mockErrorResponse(status: number, code: string, message: string) {
  return {
    response: {
      status,
      data: {
        code,
        message,
        data: null,
        timestamp: '2026-10-20T00:00:00.000Z',
        success: false,
        error: code,
      },
    },
  };
}
