/**
 * 可控的 axios 实例替身（T64 测试基建）
 *
 * 为什么要自己造一个 axios 实例？
 * - 本任务要测的正是 `src/api/client.ts` **内部**的行为（401 → 刷新 → 重放 → 会话过期），
 *   而现有测试的写法是 `vi.mock('../../src/api/client', ...)` —— 整个模块被换掉，
 *   内部逻辑根本没被执行，测不到任何东西；
 * - 所以这里改成**替换 axios 本身**（`vi.doMock('axios', ...)`），
 *   让 `src/api/client.ts` 的真实代码跑起来，只是它拿到的 axios 实例是可控的。
 *
 * 替身模拟了 axios 的三个关键行为：
 * 1. 请求拦截器链（`interceptors.request.use`）—— 用来验证 `Authorization` 头；
 * 2. 响应拦截器链（`interceptors.response.use`）—— 用来验证 401 处理；
 * 3. 失败时把 `config` 挂到 error 对象上（axios 的真实行为，拦截器靠它拿 `url` / `headers`）。
 */

/** 替身里的请求配置（够用即可，不追求 axios 的完整类型） */
export interface FakeRequestConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

/** 替身的响应处理函数（由用例决定每个 url 返回什么 / 抛什么） */
export type FakeHandler = (config: FakeRequestConfig) => Promise<unknown>;

/** 构造一个带 `response` 的 HTTP 错误（模拟 axios 的 `AxiosError`） */
export function httpError(
  status: number,
  body: unknown,
): Error & { response: { status: number; data: unknown }; config?: FakeRequestConfig } {
  const err = new Error(`HTTP ${status}`) as Error & {
    response: { status: number; data: unknown };
    config?: FakeRequestConfig;
  };
  err.response = { status, data: body };
  return err;
}

/** 造一个成功响应体（后端统一 envelope） */
export function okResponse(data: unknown): { data: Record<string, unknown> } {
  return { data: { code: 0, data, timestamp: '2026-10-20T00:00:00.000Z', success: true } };
}

/** 造一个失败响应体（后端统一 envelope） */
export function failResponse(code: string, message?: string): Record<string, unknown> {
  return {
    code,
    message: message ?? '',
    data: null,
    timestamp: '2026-10-20T00:00:00.000Z',
    success: false,
    error: code,
  };
}

export class FakeAxiosInstance {
  /** 已注册的请求拦截器（按注册顺序执行） */
  requestInterceptors: Array<(c: FakeRequestConfig) => FakeRequestConfig | Promise<FakeRequestConfig>> = [];
  /** 已注册的响应拦截器（真实 axios 只有一个响应拦截器链，这里也只用一个） */
  responseInterceptors: Array<{
    onFulfilled?: (r: unknown) => unknown;
    onRejected?: (e: unknown) => unknown;
  }> = [];
  /** 每个请求的实际处理函数（用例按 url 分派） */
  handler: FakeHandler = async () => okResponse(null);
  /** 所有**实际发出**的请求配置（含重放），用于断言「重放了几次 / 带什么头」 */
  calls: FakeRequestConfig[] = [];

  interceptors = {
    request: {
      use: (fn: (c: FakeRequestConfig) => FakeRequestConfig | Promise<FakeRequestConfig>) => {
        this.requestInterceptors.push(fn);
        return this.requestInterceptors.length;
      },
    },
    response: {
      use: (onFulfilled?: (r: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
        this.responseInterceptors.push({ onFulfilled, onRejected });
        return this.responseInterceptors.length;
      },
    },
  };

  /** 模拟 axios 的请求管线：请求拦截器 → handler → 响应拦截器 */
  async request(config: FakeRequestConfig): Promise<unknown> {
    let cfg: FakeRequestConfig = { ...config, headers: { ...(config.headers ?? {}) } };
    for (const fn of this.requestInterceptors) {
      cfg = await fn(cfg);
    }
    this.calls.push(cfg);

    try {
      const res = await this.handler(cfg);
      const onFulfilled = this.responseInterceptors[0]?.onFulfilled;
      return onFulfilled ? onFulfilled(res) : res;
    } catch (e) {
      const err = e as { config?: FakeRequestConfig };
      // axios 的真实行为：失败时 error.config 指向本次请求配置
      if (!err.config) err.config = cfg;
      const onRejected = this.responseInterceptors[0]?.onRejected;
      return onRejected ? onRejected(err) : Promise.reject(e);
    }
  }

  get(url: string, config?: FakeRequestConfig): Promise<unknown> {
    return this.request({ url, method: 'get', ...(config ?? {}) });
  }

  post(url: string, data?: unknown, config?: FakeRequestConfig): Promise<unknown> {
    return this.request({ url, method: 'post', data, ...(config ?? {}) });
  }

  put(url: string, data?: unknown, config?: FakeRequestConfig): Promise<unknown> {
    return this.request({ url, method: 'put', data, ...(config ?? {}) });
  }

  patch(url: string, data?: unknown, config?: FakeRequestConfig): Promise<unknown> {
    return this.request({ url, method: 'patch', data, ...(config ?? {}) });
  }

  delete(url: string, config?: FakeRequestConfig): Promise<unknown> {
    return this.request({ url, method: 'delete', ...(config ?? {}) });
  }
}
