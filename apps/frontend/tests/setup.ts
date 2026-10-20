import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * 前端测试全局 setup（T61）
 *
 * 职责：
 * 1. 注入 jest-dom 断言扩展（toBeInTheDocument / toHaveTextContent ...）
 * 2. 每个用例后清理 DOM + 还原 mock（防止用例间状态泄漏 —— 与 T81 后端同思路）
 * 3. 提供 jsdom 缺失的浏览器 API mock（matchMedia / scrollTo / ResizeObserver）
 * 4. 提供 localStorage 兜底实现（见下方长注释）
 */

/**
 * 🔴 localStorage 兜底 —— Node ≥22 的实验性内置 localStorage 会**遮蔽** jsdom 的实现
 *
 * 实测（2026-10-20，Node **v26.12.0**）：
 *   - `globalThis.localStorage` 是一个 **configurable getter**，不带 `--localstorage-file`
 *     时返回 `undefined`，并打印 `ExperimentalWarning: localStorage is not available ...`
 *   - `window.localStorage` **同样**是 `undefined`（vitest 的 jsdom 环境把 globalThis
 *     当作 window，Node 的内置 getter 优先）
 *   - zustand `persist` 写 localStorage → 拿到 undefined → 组件/用例直接崩
 *     （实测报错：`Cannot read properties of undefined (reading 'clear')`）
 *
 * 两条备选及其问题：
 *   - 给 node 加 `--localstorage-file` → CI / 本地 / IDE 三处都要配，环境耦合重
 *   - 依赖 jsdom 的实现 → 随 vitest / jsdom / node 版本漂移，且已被 Node 遮蔽
 *
 * 故：**用内存 Map 实现一个最小 Storage**，语义对齐 Web Storage 的 5 个方法。
 * 这让测试与 node/jsdom 版本彻底解耦。
 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  } as Storage;
}

function installLocalStorage(): void {
  const isUsable = (v: unknown): v is Storage => !!v && typeof (v as Storage).getItem === 'function';

  // globalThis
  if (!isUsable((globalThis as { localStorage?: unknown }).localStorage)) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: createMemoryStorage(),
    });
  }
  // window（vitest jsdom 下 window 与 globalThis 通常同一对象，重复定义也无害）
  if (typeof window !== 'undefined' && !isUsable((window as { localStorage?: unknown }).localStorage)) {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: (globalThis as { localStorage: Storage }).localStorage,
    });
  }
}

installLocalStorage();

/** jsdom 未实现 matchMedia —— 任何走媒体查询的组件都会崩 */
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

/** jsdom 未实现 scrollTo —— 路由跳转 / 锚点会崩 */
if (typeof window !== 'undefined' && !window.scrollTo) {
  Object.defineProperty(window, 'scrollTo', { writable: true, value: vi.fn() });
}

/** jsdom 未实现 ResizeObserver —— 图表 / 响应式组件会崩 */
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/** zustand persist 会写 localStorage —— 每个用例从干净状态开始 */
beforeEach(() => {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (ls) ls.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
