import { create } from 'zustand';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';

/**
 * 自选列表共享状态（`GET/POST/DELETE /api/watch`）
 *
 * ## 为什么单独一个 store（而不是每个页面各 `GET /api/watch`）
 *
 * 「加自选」按钮要挂到多个页面（K线 / 策略信号 / 交易录入 / 候选池），
 * 每个页面都要知道「当前标的在不在自选里」。若各页各自拉一次列表：
 *   - 进 4 个页面就发 4 次 `GET /api/watch`（桌面 SPA 无多用户，重复取数无意义）；
 *   - 4 份本地 state 各管各的，「A 页刚加入、B 页按钮还没变已自选」的漂移。
 *
 * ⇒ 收敛到**一个进程级 store**：`codes`（当前用户在自选里的标的代码集合）+ 三个动作
 *   （`load` / `add` / `remove`），各页面按需订阅，动作内部**同步更新本地状态**，
 *   故加完立即反映到所有已挂载的 `WatchButton`，无需各页重新拉列表。
 *
 * ⚠️ 这是**服务端状态**（不是 user 会话）：
 *   - 用 zustand 但不加 `persist`（`GET /api/watch` 才是真相源，别把服务端数据落 localStorage）；
 *   - 首次使用 `add`/`remove` 前若还没 `load` 过，会自动补一次 `load`（懒加载，避免按钮闪烁）。
 *
 * 🔴 **错误静默降级**：`load` 失败不影响页面（按钮保持「加入自选」可点），
 *    与 `useAssetNames` 同口径 —— 名称/状态都是**增强信息**，不让整页崩。
 */

interface WatchState {
  /** 当前用户在自选里的标的代码（去重、排序，稳定 diff） */
  codes: string[];
  /** 是否已完成一次 `GET /api/watch` */
  loaded: boolean;
  /** `load` 进行中（防止并发重复拉） */
  loading: boolean;
  /** 加入 / 移除进行中的标的代码（按钮级 loading，防双击） */
  pendingCode: string | null;
  /** 最近一次操作的中文提示（成功 / 失败），null = 无 */
  message: string | null;
  load: () => Promise<void>;
  add: (code: string) => Promise<void>;
  remove: (code: string) => Promise<void>;
}

const EMPTY: string[] = [];

export const useWatchStore = create<WatchState>()((set, get) => ({
  codes: EMPTY,
  loaded: false,
  loading: false,
  pendingCode: null,
  message: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, message: null });
    try {
      const res = await api.get('/watch');
      if (isOkEnvelope(res.data)) {
        const rows = Array.isArray(res.data.data) ? (res.data.data as Array<{ asset_code?: string }>) : [];
        const codes = [
          ...new Set(rows.map((r) => String(r.asset_code ?? '')).filter((c) => c !== '')),
        ].sort();
        set({ codes, loaded: true, loading: false });
      } else {
        set({ loading: false });
      }
    } catch {
      // 列表取不到时保持现状（按钮仍可点，点了会再试），不向页面抛错
      set({ loading: false });
    }
  },

  add: async (code) => {
    const target = code.trim().toLowerCase();
    if (!target || get().pendingCode) return;
    // 尚未加载过 ⇒ 先补一次，避免把「已在自选」误判成「未加入」
    if (!get().loaded) await get().load();
    if (get().codes.includes(target)) {
      set({ message: `${code} 已在自选` });
      return;
    }
    set({ pendingCode: target, message: null });
    try {
      const res = await api.post('/watch', { asset_code: code });
      if (isOkEnvelope(res.data)) {
        // 服务端确认加入成功 ⇒ 同步本地状态
        set((s) => ({ pendingCode: null, message: '已加入自选', codes: sortedUnion(s.codes, target) }));
      } else {
        // 服务端明确拒绝（非 0 错误码）⇒ **不改本地 codes**（否则「已在自选」是幻读，刷新后对不上）
        set({ pendingCode: null, message: String(res.data?.message ?? '加入自选失败') });
      }
    } catch (err) {
      // 只有 409「已在自选」才视为该标的确实已在列表里（同步本地）；
      // 其余错误（500 / 网络等）**不改本地 codes**，只提示 —— 避免本地以为加了、服务端其实没有。
      if (isDuplicateWatchError(err)) {
        set((s) => ({
          pendingCode: null,
          message: `${code} 已在自选`,
          codes: s.codes.includes(target) ? s.codes : sortedUnion(s.codes, target),
        }));
      } else {
        set({ pendingCode: null, message: extractErrorMessage(err, '加入自选失败') });
      }
    }
  },

  remove: async (code) => {
    const target = code.trim().toLowerCase();
    if (!target || get().pendingCode) return;
    set({ pendingCode: target, message: null });
    try {
      const res = await api.delete(`/watch/${encodeURIComponent(target)}`);
      if (isOkEnvelope(res.data)) {
        set((s) => ({
          pendingCode: null,
          message: '已移出自选',
          codes: s.codes.filter((c) => c !== target),
        }));
      } else {
        set({ pendingCode: null, message: String(res.data?.message ?? '移出自选失败') });
      }
    } catch (err) {
      set({ pendingCode: null, message: extractErrorMessage(err, '移出自选失败') });
    }
  },
}));

/** 订阅式：当前标的在不在自选里（各按钮 / 页面用） */
export function useIsWatched(code: string | null | undefined): boolean {
  const codes = useWatchStore((s) => s.codes);
  return typeof code === 'string' && code !== '' && codes.includes(code.trim().toLowerCase());
}

/** 触发一次加载（页面挂载时调用；幂等 —— 已加载 / 加载中不重复） */
export function ensureWatchLoaded(): void {
  const s = useWatchStore.getState();
  if (s.loaded || s.loading) return;
  void s.load();
}

/** 稳定并集 + 排序（去重、忽略大小写后统一小写） */
function sortedUnion(list: string[], item: string): string[] {
  const next = new Set(list);
  next.add(item);
  return [...next].sort();
}

/** 判定一个 axios 错误是否「已在自选」（409 DUPLICATE / 文案含「已在」） */
function isDuplicateWatchError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 409) return true;
  const msg = String((err as { message?: unknown })?.message ?? '');
  return msg.includes('已在') || msg.includes('DUPLICATE');
}
