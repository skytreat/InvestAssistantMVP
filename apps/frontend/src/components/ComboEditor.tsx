import React, { useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
// 组件层只能依赖 `theme/styles`（不能反向依赖 `pages/_shared`）
import { buttonStyle, inputStyle as themeInputStyle } from '../theme/styles';
import PluginParamForm, { paramDefault, validateParamValues, type ParamField } from './PluginParamForm';

/**
 * 组合策略编辑器（T133 / PA-08）
 *
 * 口径（方案 §6 / PRD_v3 §4.1）：
 * - **D1：只做 AND**（界面不提供 OR/嵌套）；
 * - 条件可独立开关与调参（INV-S3-19）；
 * - 适用品种 6 档；**跨境两档后端暂无标维分类**（行情层无该字段）⇒ 明确提示「当前不产出信号」；
 * - 冷却根数默认 3（1~20 整数）；
 * - 条件候选只含 monitor 且非风险/组合级插件（父组件已过滤，这里兜底再滤一次）。
 */

export interface ComboPluginOption {
  id: string;
  name: string;
  category: string;
  subCategory?: string;
  requiresPositions?: boolean;
  paramSchema: ParamField[];
  params?: Record<string, unknown>;
}

export interface ComboConditionDraft {
  pluginId: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface ComboItem {
  id: string;
  name: string;
  enabled: boolean;
  assetScope: string;
  cooldownBars: number;
  configVersion: number;
  conditions: Array<{ pluginId: string; enabled: boolean; params: Record<string, unknown>; seq: number }>;
}

interface Props {
  plugins: ComboPluginOption[];
  initial?: ComboItem | null;
  onSaved: (combo: ComboItem) => void;
  onCancel: () => void;
}

export const COMBO_SCOPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全市场' },
  { value: 'stock', label: '仅股票' },
  { value: 'etf', label: '仅 ETF' },
  { value: 'exclude_cash', label: '排除现金类' },
  { value: 'cross_border', label: '仅跨境' },
  { value: 'exclude_cross_border', label: '排除跨境' },
];

/** 行情层没有「标维跨境分类」⇒ 这两档当前跑不出信号，必须在界面上说清楚 */
export const UNAVAILABLE_SCOPES = new Set(['cross_border', 'exclude_cross_border']);

export function isComboConditionCandidate(plugin: ComboPluginOption): boolean {
  return plugin.category === 'monitor' && plugin.subCategory !== 'risk' && plugin.requiresPositions !== true;
}

function paramsOf(plugin: ComboPluginOption, current?: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const field of plugin.paramSchema ?? []) {
    next[field.key] = current?.[field.key] !== undefined ? current[field.key] : paramDefault(field);
  }
  return next;
}

function toDrafts(initial: ComboItem | null | undefined, plugins: ComboPluginOption[]): ComboConditionDraft[] {
  if (initial && initial.conditions.length > 0) {
    return initial.conditions.map((condition) => {
      const plugin = plugins.find((item) => item.id === condition.pluginId);
      return {
        pluginId: condition.pluginId,
        enabled: condition.enabled,
        params: plugin ? paramsOf(plugin, condition.params) : { ...condition.params },
      };
    });
  }
  const first = plugins[0];
  const second = plugins[1];
  const drafts: ComboConditionDraft[] = [];
  if (first) drafts.push({ pluginId: first.id, enabled: true, params: paramsOf(first) });
  if (second) drafts.push({ pluginId: second.id, enabled: true, params: paramsOf(second) });
  return drafts;
}

export default function ComboEditor({ plugins, initial, onSaved, onCancel }: Props) {
  const candidates = plugins.filter(isComboConditionCandidate);
  const [name, setName] = useState(initial?.name ?? '');
  const [assetScope, setAssetScope] = useState(initial?.assetScope ?? 'all');
  const [cooldownBars, setCooldownBars] = useState(initial?.cooldownBars ?? 3);
  const [conditions, setConditions] = useState<ComboConditionDraft[]>(() => toDrafts(initial, candidates));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchCondition = (index: number, patch: Partial<ComboConditionDraft>) => {
    setConditions((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const changePlugin = (index: number, pluginId: string) => {
    const plugin = candidates.find((item) => item.id === pluginId);
    patchCondition(index, { pluginId, params: plugin ? paramsOf(plugin) : {} });
  };

  const addCondition = () => {
    const used = new Set(conditions.map((item) => item.pluginId));
    const next = candidates.find((item) => !used.has(item.id));
    if (!next) {
      setError('没有更多可用条件插件（同一插件不能重复作为条件）');
      return;
    }
    setError(null);
    setConditions((prev) => [...prev, { pluginId: next.id, enabled: true, params: paramsOf(next) }]);
  };

  const removeCondition = (index: number) => {
    setError(null);
    setConditions((prev) => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    setError(null);
    if (name.trim() === '') {
      setError('组合名称不能为空');
      return;
    }
    if (conditions.length < 2) {
      setError('组合至少需要 2 个条件');
      return;
    }
    const ids = conditions.map((item) => item.pluginId);
    if (new Set(ids).size !== ids.length) {
      setError('同一插件不能重复作为条件');
      return;
    }
    // 前端范围校验；后端路由二次校验兜底（防绕过）
    for (const condition of conditions) {
      const plugin = candidates.find((item) => item.id === condition.pluginId);
      if (!plugin) {
        setError(`条件插件不可用：${condition.pluginId}`);
        return;
      }
      const issue = validateParamValues(plugin.paramSchema ?? [], condition.params);
      if (issue) {
        setError(`条件「${plugin.name}」的「${issue.label}」${issue.message}`);
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        assetScope,
        cooldownBars,
        conditions: conditions.map((item) => ({
          pluginId: item.pluginId,
          enabled: item.enabled,
          params: item.params,
        })),
      };
      const res = initial
        ? await api.put(`/strategy/combos/${encodeURIComponent(initial.id)}`, payload)
        : await api.post('/strategy/combos', payload);
      if (isOkEnvelope(res.data)) {
        onSaved(res.data.data as ComboItem);
      } else {
        setError(String(res.data?.message ?? '保存失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const scopeNote = UNAVAILABLE_SCOPES.has(assetScope)
    ? '跨境分类尚未接入行情层（无标维字段），选择该品种的组合当前不会产出信号（P1 接入）。'
    : null;

  return (
    <div
      data-testid="combo-editor"
      style={{ display: 'flex', flexDirection: 'column', gap: SPACING.gapBase, marginTop: SPACING.gapBase }}
    >
      {error && <p style={{ color: COLORS.danger, fontSize: TYPO.smallSize, margin: 0 }}>{error}</p>}

      <label style={fieldStyle}>
        组合名称
        <input
          aria-label="组合名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：RSI 超卖 + MACD 金叉"
          style={inputStyle}
        />
      </label>

      <div style={{ display: 'flex', gap: SPACING.gapBase, flexWrap: 'wrap' }}>
        <label style={fieldStyle}>
          适用品种
          <select
            aria-label="适用品种"
            value={assetScope}
            onChange={(e) => setAssetScope(e.target.value)}
            style={inputStyle}
          >
            {COMBO_SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label style={fieldStyle}>
          冷却根数
          <input
            aria-label="冷却根数"
            type="number"
            min={1}
            max={20}
            value={cooldownBars}
            onChange={(e) => setCooldownBars(Number(e.target.value))}
            style={{ ...inputStyle, width: 96 }}
          />
        </label>
      </div>

      {scopeNote && (
        <p
          data-testid="combo-scope-note"
          style={{ margin: 0, color: COLORS.textMuted, fontSize: TYPO.captionSize }}
        >
          {scopeNote}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.gapBase }}>
        {conditions.map((condition, index) => {
          const plugin = candidates.find((item) => item.id === condition.pluginId);
          const rowNumber = index + 1;
          return (
            <div
              key={`${condition.pluginId}-${index}`}
              data-testid={`combo-condition-${rowNumber}`}
              style={{
                border: `1px solid ${COLORS.borderLight}`,
                borderRadius: 4,
                padding: SPACING.gapBase,
              }}
            >
              <div style={{ display: 'flex', gap: SPACING.gapBase, alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  aria-label={`条件 ${rowNumber} 插件`}
                  value={condition.pluginId}
                  onChange={(e) => changePlugin(index, e.target.value)}
                  style={inputStyle}
                >
                  {candidates.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: TYPO.smallSize }}>
                  <input
                    type="checkbox"
                    aria-label={`条件 ${rowNumber} 启用`}
                    checked={condition.enabled}
                    onChange={(e) => patchCondition(index, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                <button
                  type="button"
                  style={{ ...buttonStyle, background: COLORS.neutral }}
                  aria-label={`删除条件 ${rowNumber}`}
                  onClick={() => removeCondition(index)}
                >
                  删除
                </button>
              </div>
              {plugin && (
                <div style={{ marginTop: SPACING.gapBase }}>
                  <PluginParamForm
                    pluginId={plugin.id}
                    schema={plugin.paramSchema ?? []}
                    values={condition.params}
                    idPrefix={`combo-condition-${rowNumber}`}
                    onChange={(key, value) => patchCondition(index, { params: { ...condition.params, [key]: value } })}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: SPACING.gapBase }}>
        <button type="button" style={buttonStyle} onClick={addCondition}>
          + 添加条件
        </button>
        <button type="button" style={buttonStyle} disabled={saving} onClick={() => void save()}>
          {saving ? '保存中...' : '保存组合'}
        </button>
        <button type="button" style={{ ...buttonStyle, background: COLORS.neutral }} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: TYPO.smallSize,
  color: COLORS.textSecondary,
};
const inputStyle: React.CSSProperties = themeInputStyle;
