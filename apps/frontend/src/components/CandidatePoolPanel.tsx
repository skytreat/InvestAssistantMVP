import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, ghostButtonStyle } from '../theme/styles';
import Spinner from './Spinner';
import { SignalDirectionPill, SignalLabelTag } from './SignalPills';
import { fmt } from './positionDomain';

/**
 * Dashboard 候选池联动面板（T79 ⑥ · ux_v2 建议 F）
 *
 * 默认折叠成一条窄条「候选池 N 只 · M 只有信号」，点击展开 Top 5：
 * - 排序：**有信号优先 → 跟踪天数长优先**（再按代码字典序兜底，保证顺序确定）；
 * - 每条：代码 + 名称 + 跟踪天数 + 现价 + 信号 +【买入】；
 * - 【买入】通过 `onBuy` 交给父级打开 `TradeFormModal`，并预填现价 / 操作理由。
 *
 * ## 数据与降级
 *
 * 只发 1 次 `GET /api/candidate`（T74 已 enrich `signal` / `tracked_days` / `current_close`）。
 * 接口失败时**不拖垮 Dashboard** —— 窄条显示「候选池暂不可用」，仍可展开看空态。
 *
 * ## 为什么过滤已迁移标的
 *
 * `migrated_from_candidate === 1` 表示该候选已经迁入自选（决策完成）。
 * 它们留在候选池历史里，但**不应继续占用 Dashboard 的「跟踪」面板**；
 * 完整历史仍在 `/candidates` 页可见。
 */
export interface CandidateBuyDraft {
  assetCode: string;
  /** 现价（无行情 → null；TradeFormModal 会留空） */
  price: number | null;
  /** 操作理由（D-11 同款：策略名 + 标签 + 方向 + 日期） */
  reason: string;
}

export interface CandidatePoolPanelProps {
  /** 【买入】回调；不传时按钮仍渲染但点击无效果（由调用方接线） */
  onBuy?: (draft: CandidateBuyDraft) => void;
  /** 初始展开（默认折叠，符合 ux_v2「不占空间」） */
  defaultExpanded?: boolean;
}

interface CandidateRow {
  asset_code: string;
  name?: string | null;
  current_close?: number | null;
  tracked_days?: number | null;
  migrated_from_candidate?: number | null;
  signal?: {
    plugin_id: string;
    direction: string;
    label: string;
    trade_date: string;
  } | null;
}

/** 排序：有信号优先 → 跟踪天数长优先 → 代码字典序 */
function sortCandidates(rows: readonly CandidateRow[]): CandidateRow[] {
  return [...rows].sort((a, b) => {
    const aHas = a.signal ? 1 : 0;
    const bHas = b.signal ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;

    const aDays = a.tracked_days ?? -1;
    const bDays = b.tracked_days ?? -1;
    if (aDays !== bDays) return bDays - aDays;

    return a.asset_code.localeCompare(b.asset_code);
  });
}

/** D-11 同款理由（有信号时带策略与标签；无信号时用候选池兜底文案） */
function buildReason(row: CandidateRow): string {
  if (!row.signal) return `候选池买入 (${row.asset_code})`;
  return `${row.signal.plugin_id} ${row.signal.label} 买入 (${row.signal.trade_date})`;
}

const summaryButtonStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: SPACING.gapBase,
  padding: 0,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontFamily: TYPO.fontFamily,
  fontSize: TYPO.bodySize,
  color: COLORS.textPrimary,
  textAlign: 'left',
};

const buyButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  padding: '4px 12px',
  fontSize: TYPO.smallSize,
  whiteSpace: 'nowrap',
};

export default function CandidatePoolPanel({ onBuy, defaultExpanded = false }: CandidatePoolPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get('/candidate');
        if (cancelled) return;
        if (isOkEnvelope(res.data)) {
          setRows(Array.isArray(res.data.data) ? (res.data.data as CandidateRow[]) : []);
        } else {
          setError(res.data?.message ?? '候选池加载失败');
        }
      } catch (err) {
        if (!cancelled) setError(extractErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 已迁移的候选不再进入 Dashboard 跟踪面板（完整历史留在 /candidates） */
  const activeRows = useMemo(() => rows.filter((row) => row.migrated_from_candidate !== 1), [rows]);
  const ranked = useMemo(() => sortCandidates(activeRows), [activeRows]);
  const top = ranked.slice(0, 5);
  const signalCount = activeRows.filter((row) => row.signal !== null && row.signal !== undefined).length;

  const summaryText = loading
    ? '候选池加载中…'
    : error
      ? '候选池暂不可用'
      : `候选池 ${activeRows.length} 只 · ${signalCount} 只有信号`;

  return (
    <section aria-label="候选池" data-testid="candidate-pool-panel" style={cardStyle}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="candidate-pool-body"
        data-testid="candidate-pool-toggle"
        onClick={() => setExpanded((cur) => !cur)}
        style={summaryButtonStyle}
      >
        <span>{summaryText}</span>
        <span style={{ color: COLORS.brandLink, fontSize: TYPO.smallSize }}>
          {expanded ? '收起' : '展开'}
        </span>
      </button>

      {expanded && (
        <div
          id="candidate-pool-body"
          data-testid="candidate-pool-body"
          style={{ marginTop: SPACING.gapRelaxed }}
        >
          {loading ? (
            <Spinner />
          ) : error ? (
            <div style={{ color: COLORS.danger }}>{error}</div>
          ) : top.length === 0 ? (
            <div data-testid="candidate-pool-empty" style={{ color: COLORS.neutral, padding: '8px 0' }}>
              候选池暂无标的 ——{' '}
              <Link to="/stockscan" style={{ color: COLORS.brandLink }}>
                去条件选股
              </Link>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.gapBase }}>
                {top.map((row) => (
                  <div
                    key={row.asset_code}
                    data-testid="candidate-pool-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: SPACING.gapBase,
                      flexWrap: 'wrap',
                      paddingBottom: SPACING.gapBase,
                      borderBottom: `1px solid ${COLORS.borderSubtle}`,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 8,
                        flexWrap: 'wrap',
                        minWidth: 0,
                      }}
                    >
                      <code style={{ fontFamily: TYPO.monoFamily, fontSize: TYPO.bodySize }}>
                        {row.asset_code}
                      </code>
                      {row.name ? (
                        <span style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
                          {row.name}
                        </span>
                      ) : null}
                      <span style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>
                        跟踪 {row.tracked_days ?? '--'} 天
                      </span>
                      <span style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>
                        现价 {fmt(row.current_close)}
                      </span>
                      {row.signal ? (
                        <>
                          <SignalDirectionPill direction={row.signal.direction} />
                          <SignalLabelTag label={row.signal.label} />
                        </>
                      ) : (
                        <span style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>无信号</span>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`买入 ${row.asset_code}`}
                      onClick={() =>
                        onBuy?.({
                          assetCode: row.asset_code,
                          price: row.current_close ?? null,
                          reason: buildReason(row),
                        })
                      }
                      style={buyButtonStyle}
                    >
                      买入
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: SPACING.gapBase, textAlign: 'right' }}>
                <Link
                  to="/candidates"
                  style={{
                    ...ghostButtonStyle,
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                >
                  查看全部候选 →
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
