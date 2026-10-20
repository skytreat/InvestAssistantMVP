import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  inputStyle,
  buttonStyle,
  errorStyle,
  successStyle,
  formRowStyle,
  labelStyle,
  useIsMobile,
} from './_shared';
import {
  AUTO_IMPORT_TRADE_TYPES,
  REDUCE_TRADE_TYPES,
  TRADE_TYPE_LABEL,
  USER_INITIATED_TRADE_TYPES,
  type TradeType,
} from '../components/tradeTypes';
import TradeTypeTabs from '../components/TradeTypeTabs';
import TradeEstimatePanel from '../components/TradeEstimatePanel';
import TradeReasonTags, { TRADE_REASON_TAGS } from '../components/TradeReasonTags';
import SymbolAutocomplete from '../components/SymbolAutocomplete';
import {
  TRADE_TYPE_DIRECTION,
  estimateNewPosition,
  type EstimateResult,
  type HoldingInfo,
} from '../indicators/movingWeightedCost';

/**
 * 交易录入页（T68 · 全量重写）
 *
 * ## 覆盖的缺口（`docs/audit/gap-list-2026-10-17.md`）
 *
 * | 缺口 | 描述 | 本文件位置 |
 * |---|---|---|
 * | **F-T1** | 交易类型是 `<select>` 下拉，PRD §5.4 要求顶部 Tab 切换 | `TradeTypeTabs` 组件 |
 * | **F-T2** | `trade_reason` 无 `required`、无前端阻止 | 「操作理由」字段 + `formValid` |
 * | **F-T3** | 无实时预估新均价 | `TradeEstimatePanel` + `estimateNewPosition` |
 * | **F-T4** | 减仓超持仓无红色禁用 | `GET /api/holding/:asset_code` + 超持仓红字 |
 * | **F-T5** | 无「除权补充」独立入口，无理由自动固化置灰 | Tab 次级入口 + 理由自动填 + `readOnly` |
 * | **F-T6** | 无预设标签按钮快捷填充 | `TradeReasonTags` |
 *
 * ## 权威依据
 *
 * - `docs/client/PRD.md` §5.4「交易录入弹窗」7 行要求（逐字对照实现）；
 * - `docs/client/Requirements_simplified.md` §5.1（7 种类型 + 「部分卖出/全部卖出」口径）
 *   与 §5.2（理由必填 / 除权理由固化 / 减仓清仓持仓充足性）；
 * - `docs/client/SDD.md` §4.4（前端只调已登记的端点）。
 *
 * ## 交易类型中文名的唯一来源
 *
 * ⚠️ 本文件**不再本地定义** `TRADE_TYPE_LABEL` —— 一律 import
 *   `components/tradeTypes.ts`（此前 7 种类型的中文名散落 4 个文件且互相矛盾）。
 */

/** 成交时间格式（后端 `validateTradeTime` 的同一口径：`/^\d{2}:\d{2}:\d{2}$/`）*/
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

/** 交易日期格式（`YYYY-MM-DD`）*/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 除权补充的「操作理由」前缀（Requirements §5.2：格式为「人工补充 - {除权日} {类型}」）*/
export const AUTO_REASON_PREFIX = '人工补充 - ';

/** T87：成交时间（秒级 HH:mm:ss），默认当前时间 */
function nowTimeStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface TradeResult {
  trade_id: number;
  position: {
    qty: number;
    avgCost: number;
  };
}

/**
 * 预检响应 → 是否命中「该成交时刻已被占用」
 *
 * 🔴 **契约以后端实现为准**（`apps/backend/src/routes/trade.ts:387` · SDD §4.4 已登记）：
 *   - 未占用：`{ taken: false }`
 *   - 已占用：`{ taken: true, taken_at: "<ISO8601>" }`
 *
 * ⚠️ 其余分支（`duplicate` / `exists` / `conflict` / 计数）只是**容错解析** ——
 *   万一后端将来改了字段名，前端不会静默把「已占用」当成「未占用」。
 *   解析不出来 → 视为**未命中**（不阻断提交）。
 */
function isDuplicatePayload(res: unknown): boolean {
  const body = res as { data?: { data?: unknown } } | null | undefined;
  const payload = body?.data?.data;
  if (payload === true) return true;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    // 后端实际契约（SDD §4.4）
    if (obj.taken === true) return true;
    // 容错分支
    if (obj.duplicate === true || obj.exists === true || obj.conflict === true) return true;
    const count = obj.count ?? obj.duplicate_count ?? obj.total;
    if (typeof count === 'number' && count > 0) return true;
  }
  return false;
}

/**
 * 预检**失败**时是否判定为「已占用」
 *
 * 后端契约（SDD §4.4）：参数缺失 / 非法 → **400 `PARAM_INVALID`**；
 * 内部错误 → **500**。**两者都表示「无法确定」**，一律**不阻断提交** ——
 * 预检只是提示，最终以 `POST /api/trade` 的结果为准（乐观 UI）。
 *
 * ⚠️ 唯一例外：HTTP **409**（冲突语义）才按「已占用」处理。
 */
function isDuplicateError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null | undefined)?.response?.status;
  return status === 409;
}

export default function TradeInput() {
  const isMobile = useIsMobile();

  const [assetCode, setAssetCode] = useState('');
  const [tradeType, setTradeType] = useState<TradeType>('buy');
  const [exDividendOpen, setExDividendOpen] = useState(false);
  const [tradeDate, setTradeDate] = useState<string>(todayStr());
  const [tradeTime, setTradeTime] = useState<string>(nowTimeStr());
  const [quantity, setQuantity] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [fee, setFee] = useState<string>('0');
  const [tradeReason, setTradeReason] = useState<string>('');
  /** 数量是否被用户手动改过（清仓自动填数量时用它判断要不要覆盖）*/
  const [quantityTouched, setQuantityTouched] = useState(false);

  const [holding, setHolding] = useState<HoldingInfo | null>(null);
  const [holdingError, setHoldingError] = useState<string | null>(null);
  /** 成交时刻是否已被占用（G4.5）*/
  const [duplicateHit, setDuplicateHit] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TradeResult | null>(null);

  const isExType = AUTO_IMPORT_TRADE_TYPES.includes(tradeType);
  const isReduceType = REDUCE_TRADE_TYPES.includes(tradeType);
  const reasonRequired = USER_INITIATED_TRADE_TYPES.includes(tradeType);

  /* ── 响应式（ux_v2 §6 Phase 1：formRow 在 <768px 垂直堆叠） ── */
  const rowStyle: React.CSSProperties = isMobile
    ? { ...formRowStyle, flexDirection: 'column', alignItems: 'stretch', gap: SPACING.gapTight }
    : { ...formRowStyle, flexDirection: 'row' };
  const rowLabelStyle: React.CSSProperties = isMobile ? { ...labelStyle, minWidth: 0 } : labelStyle;
  const controlStyle: React.CSSProperties = isMobile
    ? { ...inputStyle, width: '100%', boxSizing: 'border-box' }
    : { ...inputStyle, flex: 1, minWidth: 0 };

  /* ── 拉取当前持仓（减仓 / 清仓的持仓充足性校验 + 预估面板的均价来源） ── */
  useEffect(() => {
    const code = assetCode.trim();
    if (!code) {
      setHolding(null);
      setHoldingError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        // 🔴 端点以**后端实现**为准（不是实施计划卡片里写的 /api/positions/:asset_code）：
        //    `apps/backend/src/routes/trade.ts:446` 登记的是 `GET /api/holding/:asset_code`，
        //    SDD §4.4 的路由清单也是 `/api/holding`（单标的查询为同名前缀）。
        const res = await api.get(`/holding/${encodeURIComponent(code)}`);
        if (cancelled) return;
        const payload = (res?.data?.data ?? null) as { totalQuantity?: number; avgCost?: number } | null;
        setHolding(
          payload
            ? {
                quantity: Number(payload.totalQuantity) || 0,
                avgCost: Number(payload.avgCost) || 0,
              }
            : null,
        );
        setHoldingError(null);
      } catch {
        if (cancelled) return;
        setHolding(null);
        // 拉取失败**不阻断提交**（服务端仍会二次校验），只提示用户
        setHoldingError('持仓信息获取失败，持仓充足性校验暂不可用');
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [assetCode]);

  /* ── G4.5：成交时刻占用预检（乐观 UI：失败 / 超时不阻断提交） ── */
  useEffect(() => {
    const code = assetCode.trim();
    if (!code || !tradeDate || !tradeTime) {
      setDuplicateHit(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/trade/check-duplicate', {
          params: {
            asset_code: code,
            trade_type: tradeType,
            trade_date: tradeDate,
            trade_time: tradeTime,
          },
        });
        if (cancelled) return;
        setDuplicateHit(isDuplicatePayload(res));
      } catch (err) {
        if (cancelled) return;
        setDuplicateHit(isDuplicateError(err));
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [assetCode, tradeType, tradeDate, tradeTime]);

  /* ── 除权补充：理由由系统固化（Requirements §5.2） ── */
  useEffect(() => {
    if (isExType) {
      setTradeReason(`${AUTO_REASON_PREFIX}${tradeDate} ${TRADE_TYPE_LABEL[tradeType]}`);
    }
  }, [isExType, tradeDate, tradeType]);

  /* ── 清仓：自动填入当前持仓数量（ux_v2：切 Tab 时字段联动） ── */
  useEffect(() => {
    if (tradeType !== 'clear' || quantityTouched) return;
    if (!holding || holding.quantity <= 0) return;
    setQuantity(String(holding.quantity));
  }, [tradeType, quantityTouched, holding]);

  /* ── 解析后的数值 ── */
  const parsedQuantity = quantity.trim() === '' ? NaN : Number(quantity);
  const parsedPrice = price.trim() === '' ? NaN : Number(price);
  const parsedFee = fee.trim() === '' ? 0 : Number(fee);

  /* ── 实时预估（买入 / 加仓 / 减仓 / 清仓才参与移动加权） ── */
  const estimate: EstimateResult | null = useMemo(() => {
    const direction = TRADE_TYPE_DIRECTION[tradeType];
    if (!direction) return null;
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) return null;
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) return null;
    return estimateNewPosition({
      currentQuantity: holding?.quantity ?? 0,
      currentAvgCost: holding?.avgCost ?? 0,
      direction,
      quantity: parsedQuantity,
      price: parsedPrice,
      fee: Number.isFinite(parsedFee) ? parsedFee : 0,
    });
  }, [tradeType, parsedQuantity, parsedPrice, parsedFee, holding]);

  const oversold = estimate?.oversold === true;
  const reasonValid = !reasonRequired || tradeReason.trim() !== '';
  const quantityValid = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
  const priceValid = Number.isFinite(parsedPrice) && parsedPrice >= 0;
  const dateValid = DATE_RE.test(tradeDate);
  const timeValid = TIME_RE.test(tradeTime);
  const formValid =
    quantityValid && priceValid && reasonValid && dateValid && timeValid && !oversold && !duplicateHit;

  /* ── 交易类型切换（字段联动） ── */
  const handleTypeChange = (next: TradeType) => {
    setTradeType(next);
    setQuantityTouched(false);
    // 从除权补充切回用户主动交易 → 清掉系统固化的理由
    if (!AUTO_IMPORT_TRADE_TYPES.includes(next)) {
      setTradeReason((prev) => (prev.startsWith(AUTO_REASON_PREFIX) ? '' : prev));
    }
  };

  const handleToggleExDividend = () => {
    const next = !exDividendOpen;
    setExDividendOpen(next);
    // 收起次级面板时，若当前是除权类型 → 回到默认的「买入」
    if (!next && AUTO_IMPORT_TRADE_TYPES.includes(tradeType)) {
      setTradeType('buy');
      setTradeReason('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setResult(null);
    if (!formValid) {
      setError('请检查表单后再提交');
      return;
    }

    const payload = {
      asset_code: assetCode.trim(),
      trade_type: tradeType,
      trade_date: tradeDate,
      trade_time: tradeTime,
      quantity: Number(quantity),
      price: Number(price),
      fee: Number(fee) || 0,
      trade_reason: tradeReason.trim(),
    };

    setLoading(true);
    try {
      const res = await api.post('/trade', payload);
      if (res.data.success) {
        setResult(res.data.data as TradeResult);
      } else {
        const errMsg = res.data.message ?? '请求失败';
        setError(errMsg === 'HOLDING_INSUFFICIENT' ? '持仓不足' : errMsg);
      }
    } catch (err) {
      const errMsg = extractErrorMessage(err);
      setError(errMsg === 'HOLDING_INSUFFICIENT' ? '持仓不足' : errMsg);
    } finally {
      setLoading(false);
    }
  };

  const reasonInvalid = reasonRequired && !reasonValid;

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>交易录入</h1>
      <div style={{ ...cardStyle, maxWidth: 600, width: '100%', boxSizing: 'border-box' }}>
        <form onSubmit={handleSubmit} noValidate>
          {/* ① 交易类型：Tab 组（PRD §5.4）*/}
          <TradeTypeTabs
            value={tradeType}
            onChange={handleTypeChange}
            exDividendOpen={exDividendOpen}
            onToggleExDividend={handleToggleExDividend}
          />

          <div style={rowStyle} data-testid="trade-form-row">
            <label htmlFor="trade-input-symbol" style={rowLabelStyle}>
              股票代码
            </label>
            <SymbolAutocomplete id="trade-input-symbol" value={assetCode} onChange={setAssetCode} />
          </div>

          <div style={rowStyle} data-testid="trade-form-row">
            <label htmlFor="trade-input-date" style={rowLabelStyle}>
              交易日期
            </label>
            <input
              id="trade-input-date"
              style={controlStyle}
              type="date"
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
              aria-invalid={!dateValid}
              required
            />
          </div>

          <div style={rowStyle} data-testid="trade-form-row">
            <label htmlFor="trade-input-time" style={rowLabelStyle}>
              成交时间
            </label>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                id="trade-input-time"
                style={{
                  ...controlStyle,
                  ...(duplicateHit ? { border: `1px solid ${COLORS.danger}` } : {}),
                }}
                type="time"
                step="1"
                value={tradeTime}
                onChange={(e) => setTradeTime(e.target.value)}
                aria-invalid={duplicateHit}
                aria-describedby="trade-time-hint"
                required
              />
              {/* G4.5：成交时刻已被占用 → 禁用提交并提示 */}
              <div
                id="trade-time-hint"
                data-testid="trade-time-hint"
                style={{
                  fontSize: TYPO.captionSize,
                  marginTop: SPACING.gapTight,
                  color: duplicateHit ? COLORS.danger : COLORS.textSecondary,
                }}
              >
                {duplicateHit
                  ? '该成交时刻已被占用（同日同标的同类型），请修改成交时间'
                  : '同日同标的同类型可分笔录入，成交时间需精确到秒'}
              </div>
            </div>
          </div>

          <div style={rowStyle} data-testid="trade-form-row">
            <label htmlFor="trade-input-quantity" style={rowLabelStyle}>
              数量
            </label>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                id="trade-input-quantity"
                style={{
                  ...controlStyle,
                  ...(oversold ? { border: `1px solid ${COLORS.danger}` } : {}),
                }}
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  setQuantityTouched(true);
                }}
                aria-invalid={oversold}
                aria-describedby="trade-quantity-hint"
                required
              />
              {/* ⑤ 减仓 / 清仓：超持仓 → 红字（提交按钮同时被禁用）*/}
              <div
                id="trade-quantity-hint"
                data-testid="trade-quantity-hint"
                style={{
                  fontSize: TYPO.captionSize,
                  marginTop: SPACING.gapTight,
                  color: oversold ? COLORS.danger : COLORS.textSecondary,
                }}
              >
                {oversold
                  ? `超出持仓：当前持仓 ${estimate?.available ?? 0} 股，最多可卖 ${estimate?.available ?? 0} 股`
                  : isReduceType && holding
                    ? `当前持仓 ${holding.quantity} 股`
                    : ''}
              </div>
            </div>
          </div>

          <div style={rowStyle} data-testid="trade-form-row">
            <label htmlFor="trade-input-price" style={rowLabelStyle}>
              价格
            </label>
            <input
              id="trade-input-price"
              style={controlStyle}
              type="number"
              step="0.0001"
              min={0}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </div>

          <div style={rowStyle} data-testid="trade-form-row">
            <label htmlFor="trade-input-fee" style={rowLabelStyle}>
              手续费
            </label>
            <input
              id="trade-input-fee"
              style={controlStyle}
              type="number"
              step="0.0001"
              min={0}
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />
          </div>

          {/* ④ 实时预估面板 */}
          <TradeEstimatePanel
            tradeType={tradeType}
            quantity={parsedQuantity}
            price={parsedPrice}
            fee={parsedFee}
            estimate={estimate}
            holding={holding}
          />

          {holdingError && (
            <div style={{ fontSize: TYPO.captionSize, color: COLORS.warning, marginBottom: 8 }}>
              {holdingError}
            </div>
          )}

          <div style={rowStyle} data-testid="trade-form-row">
            <label htmlFor="trade-input-reason" style={rowLabelStyle}>
              操作理由
            </label>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                id="trade-input-reason"
                style={{
                  ...controlStyle,
                  ...(reasonInvalid ? { border: `1px solid ${COLORS.danger}` } : {}),
                  ...(isExType ? { background: COLORS.headerBg, color: COLORS.textSecondary } : {}),
                }}
                type="text"
                placeholder="如 MACD 金叉买入 / 止损卖出"
                value={tradeReason}
                readOnly={isExType}
                aria-readonly={isExType}
                aria-invalid={reasonInvalid}
                aria-describedby="trade-reason-hint"
                onChange={(e) => setTradeReason(e.target.value)}
              />
              {/* ③ 字段级错误：紧贴字段下方 */}
              <div
                id="trade-reason-hint"
                data-testid="trade-reason-hint"
                style={{
                  fontSize: TYPO.captionSize,
                  marginTop: SPACING.gapTight,
                  color: reasonInvalid ? COLORS.danger : COLORS.textSecondary,
                }}
              >
                {reasonInvalid
                  ? '操作理由必填：买入 / 加仓 / 减仓 / 清仓时不允许为空'
                  : isExType
                    ? '除权补充的操作理由由系统固化，不可编辑'
                    : ''}
              </div>
              {/* ⑦ 预设标签按钮（按交易类型出现 / 消失）*/}
              <TradeReasonTags tags={TRADE_REASON_TAGS[tradeType]} onPick={(tag) => setTradeReason(tag)} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: SPACING.gapRelaxed, flexWrap: 'wrap' }}>
            <button type="submit" style={buttonStyle} disabled={!formValid || loading}>
              {loading ? '提交中...' : '提交交易'}
            </button>
          </div>

          {error && (
            <div role="alert" style={errorStyle}>
              {error}
            </div>
          )}
          {result && (
            <div style={successStyle}>
              提交成功！交易编号: {result.trade_id} &nbsp;|&nbsp; 最新持仓: 数量={result.position.qty}, 均价=
              {result.position.avgCost.toFixed(4)}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
