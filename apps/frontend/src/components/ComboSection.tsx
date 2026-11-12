import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import ComboEditor, { COMBO_SCOPE_OPTIONS, type ComboItem, type ComboPluginOption } from './ComboEditor';
import ConfirmDialog from './ConfirmDialog';

/**
 * 组合策略区块（T133 / PA-08，2026-11-12 起并入 /settings 页「组合策略」Tab）
 *
 * 组合 = 多个监控条件同时成立（AND）；整体强度取各条件中最弱的一环（min）。
 * 改动配置只影响未来信号，历史信号保留。
 *
 * 条件候选口径与后端 `isAllowedComboCondition` 一致：
 * monitor 且非 risk、不依赖持仓。
 */

interface PluginBrief {
  id: string;
  name: string;
  category: string;
  subCategory?: string;
  requiresPositions?: boolean;
  paramSchema: import('./PluginParamForm').ParamField[];
}

const buttonStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: TYPO.smallSize,
  fontFamily: TYPO.fontFamily,
  borderRadius: 6,
  border: `1px solid ${COLORS.borderMedium}`,
  background: COLORS.cardBg,
  color: COLORS.textPrimary,
  cursor: 'pointer',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: TYPO.cardTitleSize,
  fontWeight: 600,
  margin: '0 0 8px',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '4px 8px',
  color: COLORS.textSecondary,
};

const tdStyle: React.CSSProperties = {
  borderBottom: `1px solid ${COLORS.borderLight}`,
  padding: '6px 8px',
  verticalAlign: 'top',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: TYPO.smallSize,
};

export default function ComboSection() {
  const [plugins, setPlugins] = useState<PluginBrief[]>([]);
  const [combos, setCombos] = useState<ComboItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [comboEditorOpen, setComboEditorOpen] = useState(false);
  const [editingCombo, setEditingCombo] = useState<ComboItem | null>(null);
  const [deletingCombo, setDeletingCombo] = useState<ComboItem | null>(null);
  /** F6 / PRD U13：跨境 ETF 流动性提示（编辑组合时提示一次，本组件会话内不重复） */
  const [crossBorderHintVisible, setCrossBorderHintVisible] = useState(false);
  const [crossBorderHintShown, setCrossBorderHintShown] = useState(false);

  const maybeShowCrossBorderHint = () => {
    if (!crossBorderHintShown) {
      setCrossBorderHintShown(true);
      setCrossBorderHintVisible(true);
    }
  };

  useEffect(() => {
    api
      .get('/strategy/plugins')
      .then((res) => {
        if (isOkEnvelope(res.data)) setPlugins(res.data.data as PluginBrief[]);
      })
      .catch(() => setPlugins([]));

    // 组合接口失败不阻塞（老数据/未初始化时给空列表）
    api
      .get('/strategy/combos?include_disabled=1')
      .then((res) => {
        const raw = res.data?.data;
        const list = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { data?: unknown })?.data)
            ? ((raw as { data: ComboItem[] }).data ?? [])
            : [];
        setCombos(list as ComboItem[]);
      })
      .catch(() => setCombos([]));
  }, []);

  /** 条件候选：monitor 且非风险/需持仓（与后端 `isAllowedComboCondition` 同口径） */
  const comboPluginOptions: ComboPluginOption[] = plugins
    .filter((p) => p.category === 'monitor' && p.subCategory !== 'risk' && p.requiresPositions !== true)
    .map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      subCategory: p.subCategory,
      requiresPositions: p.requiresPositions,
      paramSchema: p.paramSchema ?? [],
    }));

  const pluginName = (id: string) => plugins.find((p) => p.id === id)?.name ?? id;
  const scopeLabel = (scope: string) => COMBO_SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope;

  const openComboEditor = (combo: ComboItem | null) => {
    setEditingCombo(combo);
    setComboEditorOpen(true);
    maybeShowCrossBorderHint();
    setMsg(null);
    setError(null);
  };

  const closeComboEditor = () => {
    setComboEditorOpen(false);
    setEditingCombo(null);
  };

  const onComboSaved = (combo: ComboItem) => {
    setCombos((prev) => {
      const exists = prev.some((item) => item.id === combo.id);
      return exists ? prev.map((item) => (item.id === combo.id ? combo : item)) : [...prev, combo];
    });
    closeComboEditor();
    setMsg(`已保存组合策略「${combo.name}」`);
  };

  const toggleCombo = async (combo: ComboItem, enabled: boolean) => {
    setMsg(null);
    try {
      const res = await api.put(`/strategy/combos/${encodeURIComponent(combo.id)}/toggle`, { enabled });
      if (isOkEnvelope(res.data)) {
        setCombos((prev) => prev.map((item) => (item.id === combo.id ? { ...item, enabled } : item)));
        setMsg(`「${combo.name}」已${enabled ? '启用' : '停用'}`);
      } else {
        setError(String(res.data?.message ?? '操作失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '操作失败'));
    }
  };

  const confirmDeleteCombo = async () => {
    if (!deletingCombo) return;
    const target = deletingCombo;
    setDeletingCombo(null);
    try {
      const res = await api.delete(`/strategy/combos/${encodeURIComponent(target.id)}`);
      if (isOkEnvelope(res.data)) {
        setCombos((prev) => prev.filter((item) => item.id !== target.id));
        setMsg(`已删除组合策略「${target.name}」（历史信号保留）`);
      } else {
        setError(String(res.data?.message ?? '删除失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '删除失败'));
    }
  };

  return (
    <div>
      {/* F6 / PRD U13：跨境 ETF 流动性提示（编辑组合时提示一次，不阻塞保存） */}
      {crossBorderHintVisible && (
        <div
          role="status"
          data-testid="strategy-crossborder-hint"
          style={{
            background: COLORS.bgPillNeutral,
            border: `1px solid ${COLORS.borderPillNeutral}`,
            borderRadius: 4,
            padding: '8px 10px',
            marginBottom: SPACING.gapRelaxed,
            fontSize: TYPO.smallSize,
            color: COLORS.textPillNeutral,
          }}
        >
          <b>跨境 ETF 提示</b>：跨境 ETF 在 A 股时段流动性受限。若组合策略适用于跨境
          ETF，请把信号视为次日参考，避免在 A 股早盘追价。
          <button
            type="button"
            style={{
              marginLeft: 8,
              background: 'transparent',
              border: 'none',
              color: COLORS.brand,
              cursor: 'pointer',
              fontSize: TYPO.smallSize,
            }}
            onClick={() => setCrossBorderHintVisible(false)}
          >
            知道了
          </button>
        </div>
      )}
      <div
        data-testid="combos-section"
        style={{
          border: `1px solid ${COLORS.borderLight}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: SPACING.gapRelaxed,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={subtitleStyle}>组合策略</h2>
          <button
            type="button"
            data-testid="combo-new"
            style={buttonStyle}
            onClick={() => openComboEditor(null)}
          >
            新建组合
          </button>
        </div>
        <p style={{ margin: '6px 0 8px', color: COLORS.textMuted, fontSize: TYPO.captionSize }}>
          组合 = 多个监控条件同时成立（AND）；整体强度取各条件中最弱的一环（min）。改动配置只影响未来信号。
        </p>

        {error && <div style={{ color: COLORS.danger, fontSize: TYPO.smallSize }}>{error}</div>}
        {msg && <div style={{ color: COLORS.textSuccess, fontSize: TYPO.smallSize }}>{msg}</div>}

        {combos.length === 0 ? (
          <p style={{ margin: 0, color: COLORS.textMuted, fontSize: TYPO.smallSize }}>
            还没有组合策略。点击「新建组合」选择 2 个及以上监控条件。
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>组合</th>
                <th style={thStyle}>条件</th>
                <th style={thStyle}>适用品种</th>
                <th style={thStyle}>冷却</th>
                <th style={thStyle}>启用</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {combos.map((combo) => (
                <tr key={combo.id} data-testid={`combo-row-${combo.id}`}>
                  <td style={tdStyle}>
                    {combo.name}
                    <div style={{ color: COLORS.textMuted, fontSize: TYPO.captionSize }}>
                      {combo.id} · v{combo.configVersion}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {combo.conditions
                      .map((c) => `${pluginName(c.pluginId)}${c.enabled ? '' : '（停用）'}`)
                      .join(' + ')}
                  </td>
                  <td style={tdStyle}>{scopeLabel(combo.assetScope)}</td>
                  <td style={tdStyle}>{combo.cooldownBars} 根</td>
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      aria-label={`${combo.name} 启用`}
                      data-testid={`combo-toggle-${combo.id}`}
                      checked={combo.enabled}
                      onChange={(e) => void toggleCombo(combo, e.target.checked)}
                    />
                  </td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      style={buttonStyle}
                      data-testid={`combo-edit-${combo.id}`}
                      onClick={() => openComboEditor(combo)}
                    >
                      编辑
                    </button>{' '}
                    <button
                      type="button"
                      style={{ ...buttonStyle, background: COLORS.neutral }}
                      data-testid={`combo-delete-${combo.id}`}
                      onClick={() => setDeletingCombo(combo)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {comboEditorOpen && (
          <ComboEditor
            plugins={comboPluginOptions}
            initial={editingCombo}
            onSaved={onComboSaved}
            onCancel={closeComboEditor}
          />
        )}
      </div>

      <ConfirmDialog
        open={deletingCombo !== null}
        title="删除组合策略"
        message={
          deletingCombo
            ? `确认删除「${deletingCombo.name}」？删除为软删，历史信号会保留，但该组合之后不再产出新信号。`
            : undefined
        }
        confirmText="删除"
        danger
        onConfirm={() => void confirmDeleteCombo()}
        onCancel={() => setDeletingCombo(null)}
      />
    </div>
  );
}
