import React from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { AUTO_IMPORT_TRADE_TYPES, type TradeType } from './tradeTypes';
import type { EstimateResult, HoldingInfo } from '../indicators/movingWeightedCost';

/**
 * 交易实时预估面板（T68 · F-T3）
 *
 * ## 依据
 *
 * - `docs/client/PRD.md` §5.4 行 240：
 *   「实时预估 | 输入买入数量 + 价格 + 手续费 → **实时显示预估新均价**；
 *   减仓超持仓 → 红色禁用提交」；
 * - `docs/audit/gap-list-2026-10-17.md` **F-T3**：
 *   现状「无实时预估新均价（只在提交**后**显示 `result.position.avgCost`）」。
 *
 * ## 口径
 *
 * 预估的**新均价**由 `src/indicators/movingWeightedCost.ts` 的
 * `estimateNewPosition` 计算 —— 那是 `packages/core` 的逐位等价副本，
 * **不在本组件里另写公式**（双端口径漂移 = G5 门槛 FAIL）。
 *
 * ⚠️ **除权补充三类（分红 / 送股 / 转增）不参与移动加权**
 *   （后端 `positionCalculator.mapToCoreTrade` 对这三类返回 `null`），
 *   故面板改为展示「现金分红 / 送转数量 / 均价不变」，
 *   **不显示新均价**（显示一个后端算不出来的数字 = 口径漂移）。
 */

/** 金额格式（保留 2 位小数）*/
export function formatMoney(value: number): string {
  return `¥${value.toFixed(2)}`;
}

/** 均价格式（保留 4 位小数 —— 与提交成功后的 `avgCost.toFixed(4)` 一致）*/
export function formatCost(value: number): string {
  return `¥${value.toFixed(4)}`;
}

export interface TradeEstimatePanelProps {
  /** 当前交易类型 */
  tradeType: TradeType;
  /** 已解析的数量（非法输入时为 NaN）*/
  quantity: number;
  /** 已解析的价格（非法输入时为 NaN）*/
  price: number;
  /** 已解析的手续费（非法输入时为 NaN）*/
  fee: number;
  /** 成本类类型（买入 / 加仓 / 减仓 / 清仓）的预估结果 */
  estimate: EstimateResult | null;
  /** 当前持仓（`GET /api/holding/:asset_code`）*/
  holding: HoldingInfo | null;
}

interface PanelRow {
  label: string;
  value: string;
  /** 危险色（超持仓等）*/
  danger?: boolean;
}

export default function TradeEstimatePanel({
  tradeType,
  quantity,
  price,
  fee,
  estimate,
  holding,
}: TradeEstimatePanelProps) {
  const isExType = AUTO_IMPORT_TRADE_TYPES.includes(tradeType);
  const rows: PanelRow[] = [];

  if (isExType) {
    // 除权补充：分红 / 送股 / 转增 —— 不参与移动加权
    if (tradeType === 'dividend') {
      rows.push({
        label: '预计现金分红',
        value: Number.isFinite(quantity) && Number.isFinite(price) ? formatMoney(quantity * price) : '—',
      });
    } else {
      rows.push({
        label: tradeType === 'bonus' ? '送股数量' : '转增数量',
        value: Number.isFinite(quantity) ? `${quantity} 股` : '—',
      });
    }
    rows.push({ label: '手续费', value: Number.isFinite(fee) ? formatMoney(fee) : '—' });
    rows.push({
      label: '持仓数量',
      value: tradeType === 'dividend' ? '不变（股息入账）' : '增加（均价不变）',
    });
    rows.push({
      label: '持仓均价',
      value: holding ? `不变（${formatCost(holding.avgCost)}）` : '不变',
    });
  } else {
    rows.push({
      label: '本次金额',
      value: estimate ? `${formatMoney(estimate.totalAmount)}（${quantity} × ${price}）` : '—',
    });
    rows.push({ label: '手续费', value: estimate ? formatMoney(estimate.totalFee) : '—' });
    rows.push({
      label: '新均价',
      // 持仓清零后均价无意义（后端 `calcPosition` 同口径返回 0）
      value: estimate ? (estimate.newQuantity > 0 ? formatCost(estimate.newAvgCost) : '—') : '—',
    });
    rows.push({ label: '新数量', value: estimate ? `${estimate.newQuantity} 股` : '—' });
  }

  const oversold = estimate?.oversold === true;

  return (
    <section
      aria-label="实时预估"
      data-testid="trade-estimate-panel"
      style={{
        border: `1px solid ${oversold ? COLORS.danger : COLORS.borderLight}`,
        borderRadius: RADIUS.md,
        background: COLORS.headerBg,
        padding: SPACING.gapBase,
        marginBottom: SPACING.formRowMarginBottom,
      }}
    >
      <div
        style={{
          fontSize: TYPO.smallSize,
          fontWeight: 600,
          color: COLORS.textPrimary,
          marginBottom: SPACING.gapBase,
        }}
      >
        实时预估
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.gapRelaxed }}>
        {rows.map((row) => (
          <div
            key={row.label}
            data-testid={`estimate-${row.label}`}
            style={{ minWidth: 110, flex: '1 1 110px' }}
          >
            <div style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary }}>{row.label}</div>
            <div
              style={{
                fontSize: TYPO.bodySize,
                fontWeight: 600,
                color: row.danger ? COLORS.danger : COLORS.textPrimary,
                fontFamily: TYPO.monoFamily,
                // ⚠️ 375px 视口下长数值（如「¥2000.00（100 × 20）」）不得把卡片撑宽
                overflowWrap: 'anywhere',
              }}
            >
              {row.value}
            </div>
          </div>
        ))}
      </div>

      {holding && !isExType && (
        <div
          data-testid="estimate-holding"
          style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary, marginTop: SPACING.gapBase }}
        >
          当前持仓：{holding.quantity} 股（均价 {formatCost(holding.avgCost)}）
        </div>
      )}

      {oversold && (
        <div
          role="alert"
          data-testid="estimate-oversold"
          style={{ fontSize: TYPO.smallSize, color: COLORS.danger, marginTop: SPACING.gapBase }}
        >
          超出持仓：当前持仓 {estimate?.available ?? 0} 股，最多可卖 {estimate?.available ?? 0} 股
        </div>
      )}
    </section>
  );
}
