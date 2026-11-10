import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';

/**
 * 批量标的名称（`GET /api/symbols/names`）。
 *
 * - 进程内缓存 + 并发去重：同一代码只请求一次，多个组件共享结果；
 * - 名称是装饰信息：请求失败 / 代码无名称时返回 `null`（调用方回退为仅显示代码），
 *   不向页面抛错；
 * - 后端单次上限 200 个代码，超出自动分批。
 */
const nameCache = new Map<string, string>();
const attempted = new Set<string>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

const BATCH_SIZE = 200;
/** 名称是装饰性数据，缓存按 FIFO 限量，避免长期驻留无限增长（全市场约 5.6k）。 */
const MAX_TRACKED_CODES = 10_000;

function notifyAll(): void {
  for (const listener of listeners) listener();
}

function rememberName(code: string, name: string): void {
  if (!nameCache.has(code) && nameCache.size >= MAX_TRACKED_CODES) {
    const oldest = nameCache.keys().next().value;
    if (oldest !== undefined) nameCache.delete(oldest);
  }
  nameCache.set(code, name);
}

function markAttempted(code: string): void {
  if (!attempted.has(code) && attempted.size >= MAX_TRACKED_CODES) {
    const oldest = attempted.values().next().value;
    if (oldest !== undefined) attempted.delete(oldest);
  }
  attempted.add(code);
}

async function fetchBatch(codes: string[]): Promise<void> {
  try {
    const res = await api.get('/symbols/names', { params: { symbols: codes.join(',') } });
    const body = res.data;
    if (!isOkEnvelope(body)) return;
    const data = body.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    for (const [code, name] of Object.entries(data as Record<string, unknown>)) {
      if (typeof name === 'string' && name.trim().length > 0) rememberName(code, name.trim());
    }
  } catch {
    // 名称加载失败不影响页面：保持代码回退
  } finally {
    for (const code of codes) inflight.delete(code);
    notifyAll();
  }
}

function scheduleFetch(codes: readonly string[]): void {
  const missing = codes.filter((code) => !attempted.has(code) && !inflight.has(code));
  if (missing.length === 0) return;
  for (const code of missing) {
    markAttempted(code);
    inflight.add(code);
  }
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    void fetchBatch(missing.slice(i, i + BATCH_SIZE));
  }
}

/**
 * 返回 `(code) => name | null`。
 *
 * `codes` 可以含 null / undefined / 重复项，内部会去重后按逗号拼接作为依赖，
 * 因此调用方直接传行数据 map 出来的数组也不会造成每次渲染都发请求。
 */
export function useAssetNames(
  codes: readonly (string | null | undefined)[],
): (code: string | null | undefined) => string | null {
  const key = Array.from(
    new Set(codes.filter((code): code is string => typeof code === 'string' && code.length > 0)),
  )
    .sort()
    .join(',');
  const [, forceRender] = useState(0);

  useEffect(() => {
    const unique = key === '' ? [] : key.split(',');
    if (unique.length === 0) return;
    const listener = () => forceRender((v) => v + 1);
    listeners.add(listener);
    scheduleFetch(unique);
    return () => {
      listeners.delete(listener);
    };
  }, [key]);

  return (code) => (typeof code === 'string' ? (nameCache.get(code) ?? null) : null);
}
