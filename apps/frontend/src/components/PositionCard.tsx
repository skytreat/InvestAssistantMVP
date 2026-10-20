import React from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import SignalMiniMenu, { type SignalTradeDraft } from './SignalMiniMenu';
import { WeightBar } from './WeightBar';
import { fmt, fmtPct, type Position, type TradeSide } from './positionDomain';

/**
 * 单只持仓的卡片（T67 · 卡 3 · F-D2）
 *
 * 依据 PRD §5.3 行 230：
 * 「**持仓卡片列表** | 每只标的：代码 + 名称、现价、持仓数量、移动加权成本、盈亏、收益率、仓位占比（进度条）」
 * —— 共 **8 项**（裁决 D-16：**不含行业**，行业是筛选维度不是卡片字段）。
 * 另加 ux_v2 建议 A 的**信号标记**（右上角）。
 *
 * ## 为什么组件是「纯 props 驱动」
 *
 * 卡 3 不碰后端、卡 4/6/7 都要复用本组件（接入交易弹窗 / 详情弹窗 / 信号菜单），
 * 故本组件**不 import 任何页面层模块** —— 依赖方向只有 `pages → components`。
 *
 * ## 信号标记为什么走 `SignalMiniMenu`（批次 5 接线后的形态）
 *
 * 批次 3 交付卡 7 时，本卡片渲染的是**裸的 `SignalBadge`**（只能看，不能点）；
 * 批次 5 接线后改为渲染 `SignalMiniMenu` —— 它内部把 `SignalBadge` 当触发器，
 * 于是「建议 A（看得见信号）」与「建议 E（点信号 → 一键下单）」在**同一个位置**闭环。
 *
 * ⚠️ **无信号时依旧没有任何触发点** —— `SignalMiniMenu` 内部直接返回
 *    `SignalBadge signal={null}`（`· 持有` 占位），符合卡 7 A5「hover 不出浮层」。
 *
 * ⚠️ **未传 `onSignalTrade` 时，Mini-Menu 里的操作按钮是 disabled 占位**
 *    （沿用卡 7 的既有约定，见 `SignalMiniMenu.tsx` 的 `menuItems`）。
 *
 * ## 窄屏不溢出（G3.5）
 *
 * 卡片根节点带 `minWidth: 0` —— CSS Grid 子项默认 `min-width: auto`，
 * 内容过宽时会**撑破网格轨道**（375px 下横向溢出就是这么来的）。
 * 再叠 `overflowWrap: 'anywhere'`，长名称 / 长代码都能折行而不是溢出。
 */
export interface PositionCardProps {
  /** 持仓数据 */
  position: Position;
  /** 标的类型（由调用方用 `isEtf(code)` 判定 —— 组件层不反向依赖页面层）*/
  assetType: 'stock' | 'etf';
  /** 交易回调（卡 4 接入交易录入弹窗）；**未接入时按钮渲染为 disabled 占位** */
  onTrade?: (assetCode: string, side: TradeSide) => void;
  /** 标的详情回调（卡 6 接入详情弹窗）；**未接入时名称不可点击** */
  onOpenDetail?: (assetCode: string) => void;
  /**
   * 信号 → 交易 一键链路回调（卡 7 接入 `SignalMiniMenu`）
   *
   * ⚠️ **未接入时 Mini-Menu 里的操作按钮是 disabled 占位**（沿用卡 7 的既有约定）——
   *    「看得见信号但点不动」比「没有入口」更糟，故显式禁用而不是静默隐藏。
   *
   * 回调产出的是一份**已预填的交易草稿**（代码 / 方向 / 数量 / 现价 / 理由），
   * 由**父级**（`pages/Dashboard.tsx`）拿去渲染 `TradeFormModal` ——
   * 弹窗**不能**渲染在 Mini-Menu 内部（菜单在鼠标移出时会卸载 → 弹窗被误关）。
   */
  onSignalTrade?: (draft: SignalTradeDraft) => void;
  /** 最新行情交易日（`summary.priceDate`）—— 信号过期判据（裁决 D-5）*/
  priceDate?: string | null;
}

/** 「值 + 标签」单元格的样式 */
const cellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

export function PositionCard({
  position,
  assetType,
  onTrade,
  onOpenDetail,
  onSignalTrade,
  priceDate,
}: PositionCardProps) {
  const { asset_code: code } = position;

  const labelStyle: React.CSSProperties = {
    fontSize: TYPO.captionSize,
    color: COLORS.textSecondary,
  };

  const valueStyle: React.CSSProperties = {
    fontSize: TYPO.bodySize,
    color: COLORS.textPrimary,
    fontWeight: TYPO.cardTitleWeight,
  };

  /**
   * 名称锚点
   *
   * ⚠️ `name` 缺失（`raw_symbol_name` 覆盖率约 70%）→ **回退显示代码**，
   *    绝不能把 `null` / `undefined` 字面量渲染到页面上（卡 3 A10）。
   */
  const nameText = position.name ?? code;
  const nameNode = onOpenDetail ? (
    <button
      type="button"
      onClick={() => onOpenDetail(code)}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        color: COLORS.brandLink,
        textDecoration: 'underline',
        cursor: 'pointer',
        fontSize: TYPO.bodySize,
        fontFamily: TYPO.fontFamily,
        textAlign: 'left',
        maxWidth: '100%',
        overflowWrap: 'anywhere',
      }}
    >
      {nameText}
    </button>
  ) : (
    <span
      style={{
        fontSize: TYPO.bodySize,
        color: COLORS.textPrimary,
        fontWeight: TYPO.cardTitleWeight,
        overflowWrap: 'anywhere',
      }}
    >
      {nameText}
    </span>
  );

  const pnl = position.unrealizedPnl;
  const pnlColor = (pnl ?? 0) >= 0 ? COLORS.success : COLORS.danger;
  const yieldValue = position.unrealizedYield;
  const yieldColor = (yieldValue ?? 0) >= 0 ? COLORS.success : COLORS.danger;

  const tradeButtonStyle: React.CSSProperties = {
    padding: '4px 10px',
    fontSize: TYPO.smallSize,
    fontFamily: TYPO.fontFamily,
    borderRadius: RADIUS.sm,
    border: `1px solid ${COLORS.borderMedium}`,
    background: COLORS.cardBg,
    color: COLORS.textPrimary,
    cursor: onTrade ? 'pointer' : 'not-allowed',
    opacity: onTrade ? 1 : 0.6,
  };

  return (
    <div
      data-testid="position-card"
      role="group"
      aria-label={`持仓 ${code}`}
      style={{
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: RADIUS.md,
        background: COLORS.cardBg,
        padding: SPACING.cardPadding,
        // Grid 子项默认 min-width:auto → 内容过宽会撑破轨道（375px 横向溢出的根因）
        minWidth: 0,
        overflowWrap: 'anywhere',
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.gapBase,
      }}
    >
      {/* ── 头部：代码 + 名称（左） / 信号标记（右） ── */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: SPACING.gapBase,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <code
              data-testid="position-card-code"
              style={{ fontFamily: TYPO.monoFamily, fontSize: TYPO.smallSize }}
            >
              {code}
            </code>
            {assetType === 'etf' && (
              <span
                data-testid="position-card-etf"
                style={{ color: COLORS.success, fontSize: TYPO.captionSize }}
              >
                ETF
              </span>
            )}
          </div>
          <div style={{ marginTop: 2 }}>{nameNode}</div>
        </div>
        {/*
          信号标记（建议 A）+ **信号 → 交易 一键链路**（建议 E / 卡 7）
          ⚠️ 这里**必须**用 `SignalMiniMenu` 而不是裸的 `SignalBadge`：
             `SignalMiniMenu` 内部自己渲染 `SignalBadge` 作为触发器，
             「无信号」时退化成 `· 持有` 占位（**不给任何触发点**，卡 7 A5）。
        */}
        <SignalMiniMenu position={position} priceDate={priceDate} onTrade={onSignalTrade} />
      </header>

      {/* ── 指标：现价 / 持仓数量 / 移动加权成本 / 盈亏 / 收益率 ── */}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: SPACING.gapBase,
          margin: 0,
        }}
      >
        <div style={cellStyle}>
          <dt style={labelStyle}>现价</dt>
          <dd style={{ ...valueStyle, margin: 0 }}>{fmt(position.currentPrice)}</dd>
        </div>
        <div style={cellStyle}>
          <dt style={labelStyle}>持仓数量</dt>
          <dd style={{ ...valueStyle, margin: 0 }}>{position.totalQuantity}</dd>
        </div>
        <div style={cellStyle}>
          <dt style={labelStyle}>移动加权成本</dt>
          <dd style={{ ...valueStyle, margin: 0 }}>{fmt(position.avgCost, 4)}</dd>
        </div>
        <div style={cellStyle}>
          <dt style={labelStyle}>盈亏</dt>
          <dd style={{ ...valueStyle, margin: 0, color: pnlColor }}>{fmt(pnl)}</dd>
        </div>
        <div style={cellStyle}>
          <dt style={labelStyle}>收益率</dt>
          <dd style={{ ...valueStyle, margin: 0, color: yieldColor }}>{fmtPct(yieldValue)}</dd>
        </div>
        <div style={cellStyle}>
          <dt style={labelStyle}>市值</dt>
          <dd style={{ ...valueStyle, margin: 0 }}>{fmt(position.marketValue)}</dd>
        </div>
      </dl>

      {/* ── 仓位占比（进度条） ── */}
      <WeightBar weight={position.weight} label={`${code} 仓位占比`} />

      {/* ── 底部：已实现盈亏（左） / 【买入】【卖出】（右） ── */}
      <footer
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: SPACING.gapBase,
          flexWrap: 'wrap',
          borderTop: `1px solid ${COLORS.borderSubtle}`,
          paddingTop: SPACING.gapBase,
        }}
      >
        <span style={labelStyle}>已实现盈亏 {fmt(position.realizedPnL)}</span>
        <div style={{ display: 'flex', gap: SPACING.gapBase }}>
          <button
            type="button"
            disabled={!onTrade}
            onClick={() => onTrade?.(code, 'buy')}
            style={tradeButtonStyle}
          >
            买入
          </button>
          <button
            type="button"
            disabled={!onTrade}
            onClick={() => onTrade?.(code, 'sell')}
            style={tradeButtonStyle}
          >
            卖出
          </button>
        </div>
      </footer>
    </div>
  );
}

export default PositionCard;
