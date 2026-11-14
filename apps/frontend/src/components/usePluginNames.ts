import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';

/**
 * plugin_id → 中文 label（与策略设置页同源：`GET /strategy/plugins`）。
 *
 * ⚠️ 前端测试里 `api` 常被 `vi.mock` 成 `vi.fn()`；若 mock 没实现该 URL，
 *    `api.get(...)` 可能返回 `undefined`。本 hook 对返回值守卫，
 *    取不到时静默降级（继续显示 plugin_id），不阻塞页面。
 */
export function usePluginNames() {
  const [pluginNameMap, setPluginNameMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const req: unknown = api.get('/strategy/plugins');
    if (!req || typeof (req as { then?: unknown }).then !== 'function') return;

    (req as Promise<{ data: unknown }>)
      .then((res) => {
        if (cancelled) return;
        const body: unknown = res.data;
        if (!isOkEnvelope(body)) return;
        const list = (body as { data?: unknown }).data as Array<{ id?: unknown; name?: unknown }> | undefined;
        if (!Array.isArray(list)) return;
        const next = new Map<string, string>();
        for (const p of list) {
          if (typeof p?.id !== 'string') continue;
          next.set(p.id, typeof p.name === 'string' && p.name ? p.name : p.id);
        }
        setPluginNameMap(next);
      })
      .catch(() => {
        /* 失败不阻塞主流程 */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /** 渲染策略列：中文名优先，缺省回退 plugin_id（或调用方给的占位符） */
  const pluginNameOf = (id: unknown, fallback = '--'): string =>
    typeof id === 'string' ? (pluginNameMap.get(id) ?? id) : fallback;

  return { pluginNameMap, pluginNameOf };
}
