/**
 * K 线指标参数面板（T71 · 参数实时生效，零网络请求）
 *
 * ## 职责
 *
 * 1. 让用户改 **MA 周期 / MACD / RSI / KDJ** 的参数；
 * 2. **越界不生效**：夹到合法区间 + 提示（「已取 X」）；
 * 3. 显示**当前生效值** + 一个「恢复默认」入口；
 * 4. a11y：每个输入都有 `<label htmlFor>` + `id` + **可见单位**（日 / 周 / 月 / 点）。
 *
 * ## 🔴 为什么改完立刻生效、且不发请求
 *
 * 面板只调 `onChange(生效参数)` —— 由页面重算指标并让图表重绘。
 * **取数与参数无关** ⇒ 参数变化不会触发任何网络请求（PRD §5.2「零网络请求」）。
 *
 * ## 字段定义来自 `chartParams.ts`
 *
 * 面板**不自己写一份字段表** —— 标签 / 单位 / 区间 / 取值 / 写值
 * 全部由 `PARAM_FIELDS` 提供 ⇒ UI 与口径不会两处各写一份而漂移。
 */

import { useMemo, useState } from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import {
  PARAM_FIELDS,
  PARAM_GROUPS,
  clampIndicatorParams,
  formatParamsSummary,
  type IndicatorParams,
  type ParamFieldDef,
  type ParamFieldKey,
} from '../indicators/chartParams';

export interface KlineParamPanelProps {
  /** 当前生效参数 */
  params: IndicatorParams;
  /** K 线根数的单位（跟随图表周期：日 / 周 / 月）*/
  unit: string;
  /** 当前图表的 K 线根数（用于「数据不足」提示；0 = 还没数据）*/
  barCount: number;
  /** 参数变化（已夹取到合法区间）*/
  onChange: (params: IndicatorParams) => void;
  /** 恢复默认 */
  onReset: () => void;
}

/** 字段 key → DOM id（保证 `label[for]` 与 `input[id]` 一一对应）*/
export function paramFieldId(key: ParamFieldKey): string {
  return `kline-param-${key}`;
}

/** 输入框的样式（与页面其它输入框保持一致）*/
const inputStyle = {
  padding: '4px 8px',
  width: 72,
  border: `1px solid ${COLORS.borderMedium}`,
  borderRadius: RADIUS.sm,
  fontSize: TYPO.bodySize,
} as const;

/**
 * 折叠状态在 **sessionStorage** 里记住
 *
 * 需求是「至少在同一次页面会话内保持」——
 * 用 `sessionStorage` 可以同时覆盖「Radix 无关的页面内组件重挂载」与
 * 「同一标签页内切走再回来」两种场景，且**不跨会话**污染下次打开。
 *
 * ⚠️ 隐私模式 / 存储被禁用时读写会抛异常 ⇒ 一律降级为「仅当前组件 state 生效」。
 */
const EXPANDED_STORAGE_KEY = 'invest.kline.paramPanel.expanded';

function readExpanded(): boolean {
  try {
    return sessionStorage.getItem(EXPANDED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistExpanded(expanded: boolean): void {
  try {
    sessionStorage.setItem(EXPANDED_STORAGE_KEY, expanded ? '1' : '0');
  } catch {
    // 存储不可用：状态仍在本组件内生效
  }
}

export default function KlineParamPanel({ params, unit, barCount, onChange, onReset }: KlineParamPanelProps) {
  /** 每个字段的提示文案（越界夹取 / 输入非法）*/
  const [messages, setMessages] = useState<Record<string, string>>({});
  /** 面板是否展开（**默认折叠**；状态写入 sessionStorage，同一次页面会话内保持）*/
  const [expanded, setExpanded] = useState<boolean>(readExpanded);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      persistExpanded(next);
      return next;
    });
  };

  /** 按分组归拢字段 */
  const grouped = useMemo(() => {
    return PARAM_GROUPS.map((group) => ({
      ...group,
      fields: PARAM_FIELDS.filter((f) => f.group === group.key),
    }));
  }, []);

  /** 单位文案：`bar` 跟随图表周期，`point` 固定为「点」*/
  const unitText = (field: ParamFieldDef): string => (field.unit === 'bar' ? unit : '点');

  /** 处理一次输入变化 */
  const handleChange = (field: ParamFieldDef, raw: string) => {
    const text = raw.trim();
    // 空 / 非数字 ⇒ **不生效**（保持上一个有效值），只提示
    if (text === '' || !Number.isFinite(Number(text))) {
      setMessages((prev) => ({ ...prev, [field.key]: '请输入数字' }));
      return;
    }
    const next = field.with(params, Number(text));
    const { params: clamped, issues } = clampIndicatorParams(next);
    onChange(clamped);
    const issue = issues.find((i) => i.key === field.key);
    setMessages((prev) => {
      const next2 = { ...prev };
      if (issue) {
        next2[field.key] = issue.message;
      } else {
        // 没被夹取 ⇒ 看是不是「数据不足」（预热期没有值，不是算错）
        const need = field.minBars(clamped);
        if (barCount > 0 && barCount < need) {
          next2[field.key] = `数据不足：当前 ${barCount} 根${unit}K线，至少需要 ${need} 根`;
        } else {
          delete next2[field.key];
        }
      }
      return next2;
    });
  };

  /** 恢复默认：清掉所有提示 */
  const handleReset = () => {
    setMessages({});
    onReset();
  };

  return (
    <section
      aria-label="指标参数"
      data-testid="kline-param-panel"
      style={{
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: RADIUS.base,
        padding: SPACING.cardPadding,
        marginBottom: SPACING.gapRelaxed,
        background: COLORS.cardBg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: SPACING.gapBase,
          marginBottom: expanded ? SPACING.gapBase : 0,
        }}
      >
        {/* 可点击的头部：展开 / 收起 + 状态指示（`aria-expanded` 供读屏识别） */}
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          aria-controls="kline-param-body"
          data-testid="kline-param-toggle"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: SPACING.gapTight,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: COLORS.textPrimary,
            fontSize: TYPO.bodySize,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <span aria-hidden="true" style={{ color: COLORS.textSecondary }}>
            {expanded ? '▾' : '▸'}
          </span>
          指标参数
          <span style={{ fontSize: TYPO.captionSize, fontWeight: 400, color: COLORS.textTertiary }}>
            {expanded ? '点击收起' : '点击展开'}
          </span>
        </button>
        {expanded && (
          <button
            type="button"
            onClick={handleReset}
            data-testid="kline-param-reset"
            style={{
              padding: '4px 12px',
              fontSize: TYPO.smallSize,
              color: COLORS.brand,
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: RADIUS.sm,
              cursor: 'pointer',
            }}
          >
            恢复默认
          </button>
        )}
      </div>

      {/* 折叠时**不渲染**字段（而不是 `hidden`）—— 否则读屏 / 自动化查询仍会命中不可见控件 */}
      <div id="kline-param-body" data-testid="kline-param-body">
        {expanded &&
          grouped.map((group) => (
            <fieldset
              key={group.key}
              style={{
                border: 'none',
                padding: 0,
                margin: `0 0 ${SPACING.gapBase} 0`,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'flex-start',
                gap: SPACING.gapRelaxed,
              }}
            >
              <legend
                style={{
                  fontSize: TYPO.smallSize,
                  color: COLORS.textSecondary,
                  padding: 0,
                  marginBottom: 4,
                  // fieldset 是 flex 容器 ⇒ legend 独占一行（否则会跟输入框挤在一起）
                  flexBasis: '100%',
                }}
              >
                {group.label}
              </legend>
              {group.fields.map((field) => {
                const id = paramFieldId(field.key);
                const message = messages[field.key];
                return (
                  <div key={field.key} style={{ display: 'flex', flexDirection: 'column' }}>
                    <label htmlFor={id} style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
                      {field.label}（{unitText(field)}）：
                    </label>
                    <input
                      id={id}
                      data-testid={id}
                      type="number"
                      inputMode="numeric"
                      min={field.range.min}
                      max={field.range.max}
                      step={field.range.step}
                      value={field.get(params)}
                      onChange={(e) => handleChange(field, e.target.value)}
                      aria-invalid={message ? true : undefined}
                      aria-describedby={message ? `${id}-hint` : undefined}
                      style={inputStyle}
                    />
                    {message && (
                      <span
                        id={`${id}-hint`}
                        data-testid={`${id}-hint`}
                        role="status"
                        aria-live="polite"
                        style={{ fontSize: TYPO.captionSize, color: COLORS.textWarning, maxWidth: 200 }}
                      >
                        {message}
                      </span>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
      </div>

      {/* 当前生效值一览（折叠时也保留 —— 不解开面板也能看到当前口径） */}
      <div
        data-testid="kline-param-summary"
        style={{ marginTop: 4, fontSize: TYPO.smallSize, color: COLORS.textTertiary }}
      >
        当前生效：{formatParamsSummary(params)}
      </div>
    </section>
  );
}
