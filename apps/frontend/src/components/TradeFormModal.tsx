import React, { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client';
import { isFailedEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, inputStyle } from '../theme/styles';
import { useDialogFocus } from './useDialogFocus';
import type { TradeSide } from './positionDomain';

/**
 * 交易录入弹窗（T67 · 卡 4 · F-D4 / ux_v2 建议 B）
 *
 * 依据：
 * - PRD §5.3 行 231「每张持仓卡片右侧【买入】【卖出】快捷按钮 → 弹出**交易录入弹窗**」；
 * - PRD §5.4 行 239「**操作理由** 买入/加仓/减仓/清仓时必填（UI 不允许空值）」；
 * - ux_v2 行 370-405 建议 B「Dashboard 持仓卡片的『买入/卖出』按钮**触发 Modal**」
 *   「打开时**自动填入**：标的代码、交易类型」「ESC 关闭 / 点击遮罩关闭」。
 *
 * ## 为什么组件是「纯 props 驱动」
 *
 * 卡 4 不碰 `pages/Dashboard.tsx`（接线归批次 5），且 **T68（Wave 4）会重写
 * `pages/TradeInput.tsx`** —— 故本组件**不 import 任何页面层模块**，
 * 依赖方向只有 `pages → components`。
 * ⇒ **T68 应让 TradeInput 复用本组件**（本组件的字段与校验口径已按后端契约实现）。
 *
 * ## 载荷字段名以**后端源码**为准（不是凭想象）
 *
 * `apps/backend/src/routes/trade.ts:103-114` 的请求体类型逐字：
 * `asset_code` / `trade_type` / `trade_date` / `trade_time` / `quantity` /
 * `price` / `fee` / `trade_reason` / `remark` / `system_followed`。
 * 本组件只发前 8 个（`remark` / `system_followed` 是后端可选字段，MVP 前端不用）。
 *
 * ## `trade_time` 为什么必填（T87 / B-11 裁决）
 *
 * 后端 `validateTradeTime`（`routes/trade.ts:29`）要求 `HH:mm:ss`（秒级）**必填无默认** ——
 * 成交时间进了主键（「同日同标的同方向同刻」唯一），给默认时间会让用户
 * 「同一秒录两笔」时静默撞唯一键而不知为何被拒。
 * ⇒ 本组件把「成交时间」做成**可编辑字段**，打开时预填当前本地时间。
 *
 * ## a11y
 *
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（`useId`，多实例不串）
 *   + `aria-describedby`（指向说明文字）；
 * - **ESC 关闭**（`document` 的 keydown，与 `ConfirmDialog.tsx:56-70` 同款实现）；
 * - **焦点锁定 + 焦点回归**（Wave 7 卡 5 · T76 ⑤）：打开时焦点移入弹窗（落在**第一个可编辑控件**上）、
 *   Tab 在弹窗内循环、关闭后焦点归还触发元素 —— 实现见 `components/useDialogFocus.ts`
 *   （原生 `keydown` + `document.activeElement`，**不引第三方库**，裁决 D-15）；
 * - 点击遮罩关闭（点在弹窗内部**不**关闭 —— 判据是 `e.target === e.currentTarget`）；
 * - 字段级提示用 `aria-describedby` 挂到控件上，读屏可播报。
 *
 * `open=false` 时**不渲染任何 DOM**（返回 null）—— 不占位、不进无障碍树
 * （与 `ConfirmDialog.tsx:68` 的约定一致）。
 */

/** 后端可选的交易类型 —— 本组件只暴露「买入 / 卖出」（由触发方决定，见 PRD §5.3 行 231）*/
const TRADE_TYPE_OPTIONS: ReadonlyArray<{ value: TradeSide; label: string }> = [
  { value: 'buy', label: '买入' },
  { value: 'sell', label: '卖出' },
];

/**
 * 交易方向 → **载荷里的 `trade_type`**
 *
 * ⚠️ **卖出方向发的是 `reduce`（减仓），不是 `'sell'`** —— 两条实测依据：
 *
 * 1. **业务层（L1 需求真相源）**：`Requirements_simplified.md` §5.1 行 95-104
 *    明确「7 种交易类型 = 买入 / 加仓 / 减仓 / 清仓 / 分红 / 送股 / 转增」，
 *    其中「**减仓 = 部分卖出**」「清仓 = 全部卖出」——
 *    **根本没有 `'sell'` 这个业务类型**。
 * 2. **存储层（DDL 实测）**：`user_trade_record.trade_type` 的 CHECK 约束是
 *    `('buy','add','reduce','clear','dividend','bonus','transfer')`（**不含 `'sell'`**）。
 *    实测（2026-10-20，本机 `data/business.db` 复制件 + 同 schema 建表）：
 *    `INSERT ... trade_type='sell'` → `SQLITE_CONSTRAINT_CHECK`，
 *    `routes/trade.ts:172-190` 的 INSERT 不做类型映射 → 直接抛 → catch 里返回
 *    **HTTP 500 INTERNAL_ERROR**（`CHECK constraint failed: ...`）。
 *
 * ⇒ UI 上仍是「买入 / 卖出」（PRD §5.3 行 231 的按钮语义），
 *    但载荷必须是 DDL 合法值：`buy` / `reduce`。
 *    `reduce` 同时命中后端的 `REDUCE_TYPES`（持仓充足性校验）与
 *    `NEED_REASON_TYPES`（操作理由必填）—— 与「卖出」的期望行为完全一致。
 *
 * ⚠️ **后端待修（不在本卡范围）**：`routes/trade.ts:132` 的白名单写的是
 *    `['buy','sell','reduce','clear','dividend','bonus','transfer']` ——
 *    **含 `'sell'`（DDL 不认 → 500）却漏了 `'add'`（DDL 认 → 被 400 拒绝）**，
 *    与 §5.1 的 7 种类型两头都对不上。已登记在交付报告里。
 */
const PAYLOAD_TRADE_TYPE: Record<TradeSide, 'buy' | 'reduce'> = {
  buy: 'buy',
  sell: 'reduce',
};

/** 成交时间格式（后端 `validateTradeTime` 的同一口径：`/^\d{2}:\d{2}:\d{2}$/`）*/
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

/** 交易日期格式（`YYYY-MM-DD`）*/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 当前本地时间（秒级 `HH:mm:ss`）—— 后端 `trade_time` 必填无默认，故前端预填 */
function nowTimeStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 当前本地日期（`YYYY-MM-DD`）*/
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 数字入参 → 输入框字符串（`undefined` → 空串；0 要保留成 '0' 而不是空串）*/
function toInputValue(v: number | string | undefined): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

/** 数量：必须 > 0（后端 `quantity <= 0` → 400 PARAM_INVALID）*/
function isPositiveNumber(v: string): boolean {
  if (v.trim() === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

/** 价格：必须 ≥ 0（后端 `price < 0` → 400 PARAM_INVALID）*/
function isNonNegativeNumber(v: string): boolean {
  if (v.trim() === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

export interface TradeFormModalProps {
  /** 是否打开；false 时**不渲染任何 DOM** */
  open: boolean;
  /** 标的代码（**预填 + 只读**）—— 来自持仓卡 */
  assetCode: string;
  /**
   * 交易方向（**由触发方决定**）
   *
   * 持仓卡【买入】→ `'buy'`；【卖出】→ `'sell'`。
   * 该值决定弹窗标题与「交易类型」控件的**初始值**（用户仍可在控件内改选）。
   */
  side: TradeSide;
  /** 标题（可选，默认「买入/卖出 + 标的代码」）*/
  title?: string;
  /** 数量初值（可选）—— 卡 7 建议 E「所有字段预填」用 */
  initialQuantity?: number | string;
  /** 价格初值（可选）*/
  initialPrice?: number | string;
  /** 手续费初值（可选，默认 0）*/
  initialFee?: number | string;
  /** 操作理由初值（可选）*/
  initialReason?: string;
  /** 点「取消」/ 按 ESC / 点遮罩 */
  onCancel: () => void;
  /**
   * 提交成功后回调
   *
   * ⚠️ **父组件负责刷新持仓**（`GET /api/holding`）—— 持仓卡与资产卡一起刷新
   *    （ux_v2 行 452-454）。本组件**不自己拉数据**（组件层不持有业务数据）。
   *    父组件收到本回调后应把 `open` 置回 `false`。
   */
  onDone?: (result?: unknown) => void;
}

export default function TradeFormModal({
  open,
  assetCode,
  side,
  title,
  initialQuantity,
  initialPrice,
  initialFee,
  initialReason,
  onCancel,
  onDone,
}: TradeFormModalProps) {
  const titleId = useId();
  const descId = useId();
  const codeId = useId();
  const typeId = useId();
  const dateId = useId();
  const timeId = useId();
  const quantityId = useId();
  const quantityHintId = useId();
  const priceId = useId();
  const priceHintId = useId();
  const feeId = useId();
  const reasonId = useId();
  const reasonHintId = useId();

  const [tradeType, setTradeType] = useState<TradeSide>(side);
  const [tradeDate, setTradeDate] = useState<string>(todayStr());
  const [tradeTime, setTradeTime] = useState<string>(nowTimeStr());
  const [quantity, setQuantity] = useState<string>(toInputValue(initialQuantity));
  const [price, setPrice] = useState<string>(toInputValue(initialPrice));
  const [fee, setFee] = useState<string>(toInputValue(initialFee ?? 0));
  const [tradeReason, setTradeReason] = useState<string>(initialReason ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 哪些字段被用户动过（决定「数量/价格」的提示是否展示）*/
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  /**
   * 焦点锁定 / 焦点回归（Wave 7 卡 5 · T76 ⑤）
   *
   * ⚠️ **默认落点 = 弹窗内第一个可编辑控件**（标的代码是只读的，跳过）——
   *    「提交交易」按钮在表单填完前是 `disabled`，无法聚焦，故不作首选。
   */
  const { dialogRef } = useDialogFocus<HTMLDivElement>(open);

  /**
   * 打开时重置表单
   *
   * ⚠️ 只在 `open` 由 false → true 的那一刻重置：
   *    父组件重渲染（哪怕传了新的 `initial*`）**不会**把用户正在填的内容冲掉。
   */
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open || wasOpen) return;
    setTradeType(side);
    setTradeDate(todayStr());
    setTradeTime(nowTimeStr());
    setQuantity(toInputValue(initialQuantity));
    setPrice(toInputValue(initialPrice));
    setFee(toInputValue(initialFee ?? 0));
    setTradeReason(initialReason ?? '');
    setError(null);
    setSubmitting(false);
    setTouched({});
  }, [open, side, initialQuantity, initialPrice, initialFee, initialReason]);

  // ESC 关闭：只在 open 时挂监听，卸载时摘掉（与 ConfirmDialog 同款实现）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 只处理本弹窗，避免同时打开的多层弹窗一起被 ESC 关掉
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  const markTouched = (field: string) =>
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));

  /* ── 本地必填校验（PRD §5.4 行 239；不发请求、直接给中文提示） ── */
  const quantityValid = isPositiveNumber(quantity);
  const priceValid = isNonNegativeNumber(price);
  const reasonValid = tradeReason.trim() !== '';
  const dateValid = DATE_RE.test(tradeDate);
  const timeValid = TIME_RE.test(tradeTime);
  const formValid = quantityValid && priceValid && reasonValid && dateValid && timeValid;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    if (!formValid) {
      // 正常路径下按钮已 disabled，走不到这里；保留兜底以防程序化提交
      setError('请检查表单：数量需大于 0、价格需大于或等于 0、操作理由不能为空');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post('/trade', {
        asset_code: assetCode.trim(),
        // 卖出方向映射为 'reduce'（DDL 合法值），详见 PAYLOAD_TRADE_TYPE 的注释
        trade_type: PAYLOAD_TRADE_TYPE[tradeType],
        trade_date: tradeDate,
        trade_time: tradeTime,
        quantity: Number(quantity),
        price: Number(price),
        fee: fee.trim() === '' ? 0 : Number(fee),
        trade_reason: tradeReason.trim(),
      });
      // 🔴 T89b：后端已删 `success` 字段 —— 失败判定看 `code`（非 0 即失败）
      const body = (res?.data ?? {}) as { code?: number | string; message?: string; data?: unknown };
      if (isFailedEnvelope(body)) {
        setError(body.message ?? '提交失败，请稍后重试');
        return;
      }
      onDone?.(body.data);
    } catch (err) {
      // 后端返回的中文 message 优先；没有才退到兜底文案（不裸取 err.response.data.message）
      setError(extractErrorMessage(err, '提交失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  };

  /** 点遮罩关闭（点在弹窗内部不关闭）*/
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    onCancel();
  };

  if (!open) return null;

  const sideLabel = tradeType === 'buy' ? '买入' : '卖出';
  const dialogTitle = title ?? `${sideLabel} ${assetCode}`;

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    // ⚠️ ux_v2 建议 B 写「遮罩 dim 0.4」，但本仓只有 token `COLORS.maskOverlay`
    //    （rgba(0,0,0,0.5)，与 ConfirmDialog 同值）—— **不新增裸值**，统一走 token。
    background: COLORS.maskOverlay,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.gapRelaxed,
    zIndex: 400,
  };

  const dialogStyle: React.CSSProperties = {
    ...cardStyle,
    // ux_v2 建议 B：Modal 宽度 600-680px、居中；`width: '100%'` 保证 375px 不横向溢出
    maxWidth: 680,
    width: '100%',
    marginBottom: 0,
    maxHeight: '85vh',
    overflowY: 'auto',
    boxSizing: 'border-box',
  };

  const titleStyle: React.CSSProperties = {
    fontSize: TYPO.h2Size,
    fontWeight: TYPO.h2Weight,
    color: COLORS.textPrimary,
    margin: 0,
  };

  const descStyle: React.CSSProperties = {
    fontSize: TYPO.smallSize,
    color: COLORS.textSecondary,
    margin: `${SPACING.gapTight} 0 ${SPACING.gapRelaxed} 0`,
  };

  const fieldStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: SPACING.gapTight,
    marginBottom: SPACING.formRowMarginBottom,
    minWidth: 0,
  };

  const fieldLabelStyle: React.CSSProperties = {
    fontSize: TYPO.smallSize,
    color: COLORS.textSecondary,
  };

  const controlStyle: React.CSSProperties = {
    ...inputStyle,
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: TYPO.fontFamily,
  };

  const readonlyControlStyle: React.CSSProperties = {
    ...controlStyle,
    background: COLORS.headerBg,
    color: COLORS.textSecondary,
  };

  const hintStyle: React.CSSProperties = {
    fontSize: TYPO.captionSize,
    color: COLORS.textSecondary,
  };

  const actionsStyle: React.CSSProperties = {
    display: 'flex',
    gap: SPACING.gapBase,
    justifyContent: 'flex-end',
    marginTop: SPACING.gapBase,
  };

  const cancelButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: COLORS.neutral,
  };

  const submitButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    cursor: formValid && !submitting ? 'pointer' : 'not-allowed',
    opacity: formValid && !submitting ? 1 : 0.6,
  };

  return (
    <div data-testid="trade-form-overlay" onClick={handleOverlayClick} style={overlayStyle}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        style={dialogStyle}
      >
        <h2 id={titleId} style={titleStyle}>
          {dialogTitle}
        </h2>
        <p id={descId} style={descStyle}>
          填写数量、价格与操作理由后提交；提交成功后持仓卡与资产卡会自动刷新。
        </p>

        {/* noValidate —— 校验口径由本组件的中文提示统一负责，不用浏览器原生气泡 */}
        <form onSubmit={handleSubmit} noValidate>
          {/* 标的代码：预填 + 只读 */}
          <div style={fieldStyle}>
            <label htmlFor={codeId} style={fieldLabelStyle}>
              标的代码
            </label>
            <input id={codeId} type="text" value={assetCode} readOnly style={readonlyControlStyle} />
          </div>

          {/* 交易类型：初值由触发方决定 */}
          <div style={fieldStyle}>
            <label htmlFor={typeId} style={fieldLabelStyle}>
              交易类型
            </label>
            <select
              id={typeId}
              value={tradeType}
              onChange={(e) => setTradeType(e.target.value as TradeSide)}
              style={controlStyle}
            >
              {TRADE_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* 交易日期 */}
          <div style={fieldStyle}>
            <label htmlFor={dateId} style={fieldLabelStyle}>
              交易日期
            </label>
            <input
              id={dateId}
              type="date"
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
              aria-invalid={!dateValid}
              style={controlStyle}
            />
          </div>

          {/* 成交时间：后端必填（秒级 HH:mm:ss），打开时预填当前时间 */}
          <div style={fieldStyle}>
            <label htmlFor={timeId} style={fieldLabelStyle}>
              成交时间
            </label>
            <input
              id={timeId}
              type="time"
              step="1"
              value={tradeTime}
              onChange={(e) => setTradeTime(e.target.value)}
              aria-invalid={!timeValid}
              style={controlStyle}
            />
          </div>

          {/* 数量 */}
          <div style={fieldStyle}>
            <label htmlFor={quantityId} style={fieldLabelStyle}>
              数量
            </label>
            <input
              id={quantityId}
              type="number"
              step="1"
              min="0"
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                markTouched('quantity');
              }}
              aria-invalid={touched.quantity ? !quantityValid : undefined}
              aria-describedby={quantityHintId}
              style={controlStyle}
            />
            <div id={quantityHintId} style={hintStyle}>
              {touched.quantity && !quantityValid ? '数量需大于 0' : ' '}
            </div>
          </div>

          {/* 价格 */}
          <div style={fieldStyle}>
            <label htmlFor={priceId} style={fieldLabelStyle}>
              价格
            </label>
            <input
              id={priceId}
              type="number"
              step="0.0001"
              min="0"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                markTouched('price');
              }}
              aria-invalid={touched.price ? !priceValid : undefined}
              aria-describedby={priceHintId}
              style={controlStyle}
            />
            <div id={priceHintId} style={hintStyle}>
              {touched.price && !priceValid ? '价格需大于或等于 0' : ' '}
            </div>
          </div>

          {/* 手续费 */}
          <div style={fieldStyle}>
            <label htmlFor={feeId} style={fieldLabelStyle}>
              手续费
            </label>
            <input
              id={feeId}
              type="number"
              step="0.0001"
              min="0"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              style={controlStyle}
            />
          </div>

          {/* 操作理由：买入/卖出必填（PRD §5.4 行 239） */}
          <div style={fieldStyle}>
            <label htmlFor={reasonId} style={fieldLabelStyle}>
              操作理由
            </label>
            <textarea
              id={reasonId}
              rows={3}
              value={tradeReason}
              placeholder="如 MACD 金叉买入 / 止损卖出"
              onChange={(e) => {
                setTradeReason(e.target.value);
                markTouched('reason');
              }}
              aria-invalid={!reasonValid}
              aria-describedby={reasonHintId}
              style={{ ...controlStyle, resize: 'vertical', fontFamily: TYPO.fontFamily }}
            />
            <div id={reasonHintId} style={hintStyle}>
              {reasonValid ? ' ' : '操作理由必填：买入/卖出时不允许为空'}
            </div>
          </div>

          <div style={actionsStyle}>
            <button type="button" style={cancelButtonStyle} onClick={onCancel} disabled={submitting}>
              取消
            </button>
            <button type="submit" style={submitButtonStyle} disabled={!formValid || submitting}>
              {submitting ? '提交中…' : '提交交易'}
            </button>
          </div>
        </form>

        {error && (
          <div role="alert" style={errorStyle}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
