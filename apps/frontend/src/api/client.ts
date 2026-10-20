import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useUserStore } from '../store/user';
import { resolveErrorMessage } from './errorMessages';

/**
 * API 客户端（T64 · 错误码统一映射 + 会话过期体验）
 *
 * 本文件承担三件事：
 *
 * 1. **统一错误映射** —— 所有从本实例流出的错误，`response.data.message` 一定是一句中文
 *    （后端给了就用后端的；没给就按 `code` 查 `errorMessages.ts` 的码表）。
 *    → 页面上永远不会出现裸错误码（G1.4b）。
 *
 * 2. **401 自动续期** —— access token 过期时用 `refresh_token` 换新的，并**重放原请求**。
 *    → 对应 PRD §5.9「支持刷新自动续期」。
 *
 * 3. **会话过期通知（pub/sub）** —— 本文件不是组件，不能用 `<Navigate>`，
 *    故导出一对极简的订阅/广播函数，由 `App.tsx` 订阅后做跳转与提示条。
 */

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * T64：**重放标记**
     *
     * 原请求用新 token 重放过一次后置位 —— 拦截器据此拒绝二次重放，
     * 避免「刷新成功但接口仍 401」时无限循环。
     */
    _retry?: boolean;
  }
}

export const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

/* ------------------------------------------------------------------ *
 * 会话过期 pub/sub（T64）
 * ------------------------------------------------------------------ */

/** 会话过期回调：参数 `from` = 过期发生时的当前路径（含 query） */
export type SessionExpiredHandler = (from: string) => void;

/** 已注册的会话过期回调（模块级） */
const sessionExpiredHandlers = new Set<SessionExpiredHandler>();

/**
 * 订阅「会话过期」事件，返回取消订阅函数
 *
 * 用法（`App.tsx`）：
 * ```ts
 * useEffect(() => onSessionExpired((from) => setExpiredFrom(from)), []);
 * ```
 */
export function onSessionExpired(handler: SessionExpiredHandler): () => void {
  sessionExpiredHandlers.add(handler);
  return () => {
    sessionExpiredHandlers.delete(handler);
  };
}

/**
 * 广播「会话过期」事件
 *
 * `from` = 过期发生时的当前路径（`window.location.pathname + window.location.search`），
 * 供前端**保留原页面路径**（PRD §5.9：登录后可返回原页面）。
 */
export function emitSessionExpired(from: string): void {
  // 复制一份再遍历：回调里可能会退订，避免遍历中修改集合
  for (const handler of Array.from(sessionExpiredHandlers)) {
    try {
      handler(from);
    } catch (err) {
      // 回调异常不能影响请求链（错误仍要原样抛给调用方）
      console.error('[api] 会话过期回调执行异常:', err);
    }
  }
}

/** 当前页面路径（含 query）—— 过期时用它作为「返回原页面」的目标 */
export function currentPath(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}`;
}

/* ------------------------------------------------------------------ *
 * 请求拦截器：附带 access token
 * ------------------------------------------------------------------ */

api.interceptors.request.use((config) => {
  const token = useUserStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/* ------------------------------------------------------------------ *
 * 刷新令牌（T64）
 * ------------------------------------------------------------------ */

/**
 * 模块级「正在进行的刷新」promise —— **并发 401 的去重标志位**
 *
 * 为什么用模块级 promise 而不是布尔标志：
 * - 布尔标志需要「谁负责清标志」的额外约定（异常路径容易漏清 → 永久卡死）；
 * - promise 天然共享：并发 401 全部 `await` 同一个 promise，**只发一次刷新请求**；
 * - `.finally` 在 promise settle 之后才清标志（回调在 microtask 里跑），
 *   故「同一帧内」并发到达的 401 全部命中同一个 in-flight promise。
 */
let refreshInFlight: Promise<string | null> | null = null;

/** 会话体（后端 `ok(session)` 的 `data` 字段） */
interface SessionPayload {
  token?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_at?: unknown;
  user?: { id?: unknown; username?: unknown; role?: unknown };
}

/**
 * 真正发一次刷新请求
 *
 * 成功后把新 token 写回 store（access + refresh 都换新 —— 后端是**轮换**语义），
 * 返回新的 access token；失败返回 `null`（由调用方决定「会话过期」）。
 */
async function requestNewToken(): Promise<string | null> {
  const { refreshToken } = useUserStore.getState();
  if (!refreshToken) return null;

  try {
    // ⚠️ body 用 **下划线** `refresh_token`（后端契约，`apps/backend/src/routes/auth.ts`）
    const res = await api.post('/auth/refresh', { refresh_token: refreshToken });
    const session = (res.data?.data ?? null) as SessionPayload | null;
    const token = typeof session?.token === 'string' ? session.token : '';
    if (token === '') return null;

    const nextRefresh = typeof session?.refresh_token === 'string' ? session.refresh_token : null;
    useUserStore.getState().setTokens(token, nextRefresh);
    return token;
  } catch (err) {
    const body = (err as AxiosError | undefined)?.response?.data as
      { message?: unknown; code?: unknown } | undefined;
    console.warn('[api] 刷新令牌失败：', resolveErrorMessage(body, '刷新登录状态失败'));
    return null;
  }
}

/**
 * 刷新令牌（**并发去重**）
 *
 * 并发 401 时全部拿到**同一个** promise → 刷新端点只被调用 1 次。
 * 这是 T64 验收点 ③「并发 401 只触发一次刷新（去重标志位）」的实现。
 */
export function refreshOnce(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  const pending = requestNewToken().finally(() => {
    // settle 之后才清标志位：同一帧内并发到达的 401 全部共享上面那个 promise
    refreshInFlight = null;
  });
  refreshInFlight = pending;
  return pending;
}

/** 判断某个请求是不是「刷新令牌」请求本身（防止 401 递归） */
function isRefreshRequest(config: { url?: string }): boolean {
  return (config.url ?? '').includes('/auth/refresh');
}

/* ------------------------------------------------------------------ *
 * 响应拦截器：统一错误映射 + 401 自动续期
 * ------------------------------------------------------------------ */

/**
 * 把错误体里的 `message` 补成中文（后端没给 message 时按 code 查表）
 *
 * 只在**缺 message** 时写入，不覆盖后端已经给好的文案。
 */
function normalizeErrorMessage(err: AxiosError): void {
  const data = err.response?.data as
    { message?: unknown; code?: unknown; error?: unknown } | undefined | null;
  if (!data || typeof data !== 'object') return;
  if (typeof data.message === 'string' && data.message.trim() !== '') return;

  try {
    const resolved = resolveErrorMessage(data, '请求失败，请稍后重试');
    data.message = resolved;
  } catch (e) {
    // 响应体不可写（只读 / 冻结对象）时不能影响错误本身的抛出
    console.warn('[api] 错误文案归一化失败：', e);
  }
}

/**
 * 响应拦截器：统一错误映射 + 401 自动续期
 *
 * 401 的处理口径（T64）：
 *
 * | 情形 | 动作 |
 * |---|---|
 * | 请求本身就是刷新请求 | 直接 reject（防递归） |
 * | 有 refresh token，刷新成功 | 重放原请求一次（带新 token，`_retry` 标记防死循环） |
 * | 有 refresh token，刷新失败 | 清会话 + 触发「会话过期」 |
 * | 没有 refresh token | 清会话 + 触发「会话过期」 |
 * | **重放后仍然 401** | **只把错误抛出去，不清会话** —— 会话刚刷新成功，本地 token 有效；|
 * | | 这一次的 401 多半是「该接口不认这个用户」而非「会话过期」，贸然登出会打断用户 |
 */
api.interceptors.response.use(
  (r) => r,
  async (err: AxiosError) => {
    const status = err.response?.status;
    const config = err.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;

    if (status === 401 && config && !config._retry && !isRefreshRequest(config)) {
      // 标记已重放过 —— 避免「刷新成功但接口仍 401」时无限循环
      config._retry = true;

      const token = await refreshOnce();
      if (token) {
        // 刷新成功 → 重放原请求一次（带新 token）
        // ⚠️ **不修改原请求的 config**（失败请求的配置对象留着不动）——
        //    复制一份再改，避免污染「已失败的那次请求」的记录。
        const retryConfig = {
          ...config,
          headers: { ...config.headers },
        } as InternalAxiosRequestConfig;
        retryConfig.headers.Authorization = `Bearer ${token}`;
        return api.request(retryConfig);
      }

      // 刷新失败 / 没有 refresh token → 清会话 + 通知前端「会话过期」
      useUserStore.getState().logout();
      emitSessionExpired(currentPath());
    }

    normalizeErrorMessage(err);
    return Promise.reject(err);
  },
);
