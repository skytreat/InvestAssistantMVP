import React from 'react';
import { COLORS, TYPO } from '../theme/tokens';
import { inputStyle, labelStyle } from '../theme/styles';

/**
 * 插件参数表单（**schema 驱动**）—— T73 · F-S2
 *
 * ## 为什么要有这个共享组件
 *
 * 插件的 `paramSchema`（后端 `services/pluginEngine.ts` 的 `ParamField` 契约）
 * 已经把「字段名 / 类型 / 取值范围 / 默认值 / 选项 / 单位」全部描述清楚了，
 * 于是**参数输入控件可以完全由 schema 生成**，不需要用户手写 JSON。
 *
 * 本组件的渲染逻辑原先是 `pages/Settings.tsx` 里的 `renderField`（T63 写的），
 * T73 把它抽出来**共用**：
 *
 * - `pages/Settings.tsx` —— 插件参数**持久化**（保存到 `strategy_plugin_config`）
 * - `pages/StockScan.tsx` —— 选股时**按插件参数过筛**（PRD §5.6「选中后自动渲染参数配置表单」）
 *
 * ⚠️ **两份实现 = 两处真理**：控件类型映射、范围提示文案、必填标记都会随时间漂移。
 *    故抽成本组件后，`Settings.tsx` 里的 `renderField` 已删除，**两页共用同一个渲染器**。
 *
 * ⚠️ **本组件只做「渲染 + 取值」，不做「提交」** ——
 *    提交语义（保存配置 / 发选股请求）由各页面自己决定。
 *
 * ## 依赖方向
 *
 * `components/*` → `theme/styles` → `theme/tokens`。
 * ⚠️ **不允许** `components/*` 反向 import `pages/*`（会形成循环依赖，见 `theme/styles.ts` 的说明）。
 */

/** 后端 ParamField 契约（apps/backend/src/services/pluginEngine.ts） */
export interface ParamField {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'integer' | 'select';
  default?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  unit?: string;
  description?: string;
  required?: boolean;
  /** T85b ①：运行时注入字段（用户不可配置，表单不渲染） */
  runtimeInjected?: boolean;
}

/** 参数默认值：用户没存过就用 schema 默认值 */
export function paramDefault(field: ParamField): unknown {
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'number' || field.type === 'integer') return field.min ?? 0;
  if (field.type === 'select') return field.options?.[0] ?? '';
  return '';
}

/**
 * 由 schema 生成一份「全默认值」参数表
 *
 * ⚠️ **只包含 `default !== undefined` 的字段** —— 与 `pages/Settings.tsx` 的
 *    `openEditor()` 原逻辑逐字一致（没有 default 的字段留空，交给后端补默认值）。
 */
export function defaultParamsFromSchema(schema: ParamField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) {
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

/**
 * 生成控件 id（T63）
 *
 * 命名规则：`<前缀>-<插件id>-<字段key>`，全部小写 kebab-case。
 * ⚠️ id 必须**页内唯一**：同一插件的多个参数各自一个字段 key，故天然不冲突；
 * 不同插件用 pluginId 隔离；不同页面用前缀（idPrefix）隔离。
 */
export function paramFieldId(prefix: string, pluginId: string, fieldKey: string): string {
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `${sanitize(prefix)}-${sanitize(pluginId)}-${sanitize(fieldKey)}`;
}

/** 校验不通过时返回的问题描述 */
export interface ParamValidationIssue {
  /** 出问题的字段 key */
  key: string;
  /** 出问题的字段标签（用于拼错误文案） */
  label: string;
  /** **可直接接在字段标签后**的短语，如「不能小于 5」 */
  message: string;
}

/**
 * 校验参数值（**前端预校验**，后端 `validatePluginParams` 仍会二次校验）
 *
 * 规则与后端 `validatePluginParams` 对齐（类型 + 范围 + 必填）：
 * - number / integer：必须是数字，且落在 [min, max] 内
 * - string / boolean / select：类型必须匹配
 * - required 且为空：报「为必填」
 *
 * ⚠️ 返回**第一条**问题（与后端「逐字段校验、先失败先返回」的口径一致），
 *    文案由调用方拼成完整句子（本函数只给字段标签 + 短语）。
 */
export function validateParamValues(
  schema: ParamField[],
  values: Record<string, unknown>,
): ParamValidationIssue | null {
  for (const f of schema) {
    const v = values[f.key];
    if (f.required && (v === '' || v === undefined || v === null)) {
      return { key: f.key, label: f.label, message: '为必填' };
    }
    if ((f.type === 'number' || f.type === 'integer') && v !== '' && v !== undefined && v !== null) {
      const num = Number(v);
      if (Number.isNaN(num)) {
        return { key: f.key, label: f.label, message: '必须是数字' };
      }
      if (f.min !== undefined && num < f.min) {
        return { key: f.key, label: f.label, message: `不能小于 ${f.min}` };
      }
      if (f.max !== undefined && num > f.max) {
        return { key: f.key, label: f.label, message: `不能大于 ${f.max}` };
      }
    }
  }
  return null;
}

export interface PluginParamFormProps {
  /** 插件 id —— 参与控件 id 的生成，保证同页多插件不撞 id */
  pluginId: string;
  /** 参数 schema（后端 `paramSchema`） */
  schema: ParamField[];
  /** 当前值（key → 值） */
  values: Record<string, unknown>;
  /** 单个字段变更回调 */
  onChange: (key: string, value: unknown) => void;
  /**
   * 控件 id 前缀（默认 `plugin`）
   *
   * 不同页面用不同前缀，避免同一浏览器里多个表单实例撞 id
   * （如 Settings 用 `settings`、StockScan 用 `stockscan`）。
   */
  idPrefix?: string;
  /**
   * 额外要隐藏的字段 key
   *
   * ⚠️ 与 `runtimeInjected` 的区别：
   * - `runtimeInjected: true` —— **后端**声明该字段由运行时注入（如 monitor 插件的 `symbol`）
   * - `hiddenKeys` —— **调用方**额外隐藏的字段（如选股页的 `symbol`：
   *   filter 类插件的 symbol 由选股路由逐标的注入，用户改它没有意义）
   */
  hiddenKeys?: string[];
}

/**
 * 插件参数表单（schema 驱动）
 *
 * 渲染规则（逐字沿用 T63 在 `Settings.tsx` 里的实现，**不改变既有视觉与文案**）：
 * - 每个字段：`<label htmlFor>` + 控件 `id`（读屏可关联）
 * - boolean：包住式 label（复选框在前、文字在后）
 * - select / number / integer / string：对应控件 + 范围提示 + 字段说明
 */
export default function PluginParamForm({
  pluginId,
  schema,
  values,
  onChange,
  idPrefix = 'plugin',
  hiddenKeys = [],
}: PluginParamFormProps) {
  const visible = schema.filter((f) => !f.runtimeInjected && !hiddenKeys.includes(f.key));
  if (visible.length === 0) return null;

  return (
    <div data-testid="plugin-param-form">
      {visible.map((f) => {
        const value = values[f.key] ?? '';
        const controlId = paramFieldId(idPrefix, pluginId, f.key);

        return (
          <div key={f.key} style={{ marginBottom: 12 }}>
            <label
              htmlFor={controlId}
              style={{ ...labelStyle, display: 'block', minWidth: 0, marginBottom: 4 }}
            >
              {f.label}
              {f.required && <span style={{ color: COLORS.danger }}> *</span>}
              {f.unit && <span style={{ color: COLORS.neutral, fontSize: 12 }}>（{f.unit}）</span>}
            </label>
            {f.type === 'boolean' && (
              // 包住式 label（label 内含唯一的 checkbox）→ 天然关联，
              // 故无需 htmlFor；此处保留包住式是为了不改「复选框在前、文字在后」的视觉顺序
              <label style={{ fontSize: TYPO.bodySize }}>
                <input
                  id={controlId}
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => onChange(f.key, e.target.checked)}
                />{' '}
                启用该选项
              </label>
            )}
            {f.type === 'select' && (
              <select
                id={controlId}
                style={{ ...inputStyle, width: '100%' }}
                value={String(value)}
                onChange={(e) => onChange(f.key, e.target.value)}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
            {(f.type === 'number' || f.type === 'integer') && (
              <input
                id={controlId}
                type="number"
                style={{ ...inputStyle, width: '100%' }}
                value={value === '' || value === undefined ? '' : String(value)}
                min={f.min}
                max={f.max}
                step={f.step ?? (f.type === 'integer' ? 1 : 'any')}
                onChange={(e) => onChange(f.key, e.target.value === '' ? '' : Number(e.target.value))}
              />
            )}
            {f.type === 'string' && (
              <input
                id={controlId}
                type="text"
                style={{ ...inputStyle, width: '100%' }}
                value={String(value)}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            )}
            {(f.min !== undefined || f.max !== undefined) && (
              <div style={{ fontSize: 12, color: COLORS.neutral, marginTop: 2 }}>
                允许范围：{f.min ?? '-∞'} ~ {f.max ?? '+∞'}
              </div>
            )}
            {f.description && (
              <div style={{ fontSize: 12, color: COLORS.neutral, marginTop: 2 }}>{f.description}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
