import React, { useCallback, useEffect } from 'react';
import { COLORS, TYPO } from '../theme/tokens';
import { useWatchStore, useIsWatched } from '../store/watch';
import { ensureWatchLoaded } from '../store/watch';

/**
 * 加入 / 移除自选按钮（跨页面复用）
 *
 * 挂到 K线 / 策略信号 / 交易录入等任意「有标的代码」的位置：
 * - 未自选 → 「加入自选」（实心品牌按钮）
 * - 已自选 → 「已自选 ✓」（描边幽灵按钮，点击可移除）
 * - 进行中 → 置灰 + 「…」
 *
 * ## 数据来源
 * 状态读自**进程级 `useWatchStore`**（见 `store/watch.ts`）：
 * 各页面共享同一份自选集合，故「K线页刚加入 → 信号页按钮立刻变已自选」无需重新拉列表。
 * 本组件挂载时调 `ensureWatchLoaded()` 懒加载一次（幂等，已加载不重复）。
 *
 * 🔴 标的代码为空（如交易录入还没选标的）时**不渲染** —— 避免「加入自选」按钮对着空气。
 */

export interface WatchButtonProps {
  /** 标的代码（如 `sh600000`）；空 / undefined 时不渲染 */
  assetCode: string;
  /** 紧凑模式（表格行内小按钮，字号小、padding 小） */
  compact?: boolean;
}

export default function WatchButton({ assetCode, compact = false }: WatchButtonProps) {
  const watched = useIsWatched(assetCode);
  const pendingCode = useWatchStore((s) => s.pendingCode);
  const add = useWatchStore((s) => s.add);
  const remove = useWatchStore((s) => s.remove);
  const message = useWatchStore((s) => s.message);

  useEffect(() => {
    ensureWatchLoaded();
  }, []);

  const handleToggle = useCallback(() => {
    if (watched) void remove(assetCode);
    else void add(assetCode);
  }, [assetCode, watched, add, remove]);

  const code = assetCode.trim();
  if (code === '') return null;

  const busy = pendingCode === code.trim().toLowerCase();

  const base: React.CSSProperties = {
    padding: compact ? '2px 8px' : '6px 14px',
    fontSize: compact ? TYPO.captionSize : TYPO.smallSize,
    borderRadius: 4,
    cursor: busy ? 'not-allowed' : 'pointer',
    border: watched ? `1px solid ${COLORS.success}` : 'none',
    background: watched ? COLORS.cardBg : COLORS.brand,
    color: watched ? COLORS.textSuccess : COLORS.cardBg,
  };

  return (
    <button
      type="button"
      data-testid="watch-toggle"
      data-code={code}
      aria-pressed={watched}
      aria-busy={busy}
      disabled={busy}
      onClick={handleToggle}
      title={watched ? '已加入自选，点击可移除' : '加入自选'}
      style={base}
    >
      {busy ? (
        '…'
      ) : watched ? (
        <span>
          已自选 <span aria-hidden="true">✓</span>
        </span>
      ) : (
        '加自选'
      )}
      {/* 操作反馈（成功 / 失败 / 已在自选）：`role="status"` 让读屏也听到，不打断焦点 */}
      {message !== null && !compact && (
        <span role="status" style={{ marginLeft: 8, fontWeight: 400 }}>
          {message}
        </span>
      )}
    </button>
  );
}
