import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { buttonStyle, cardStyle, errorStyle, pageContainerStyle, titleStyle } from './_shared';
import PluginParamForm, {
  paramDefault,
  validateParamValues,
  type ParamField,
} from '../components/PluginParamForm';
import ComboEditor, {
  COMBO_SCOPE_OPTIONS,
  type ComboItem,
  type ComboPluginOption,
} from '../components/ComboEditor';
import ConfirmDialog from '../components/ConfirmDialog';
import Spinner from '../components/Spinner';

/**
 * StrategyConfig.tsx —— 策略配置页 `/strategy/config`（V3.8 T148 · PRD_v3 §4.1）
 *
 * 交付：
 * ① 策略（插件）列表按分类展示
 * ② 启用/停用开关（PUT /api/strategy/plugins/:id/toggle）
 * ③ 参数具名编辑（paramSchema 驱动 PluginParamForm，与设置页共用渲染器）
 *
 * 适用品种维度（排除现金类）由后端 T133 `resolveSignalSymbols` 实现，本页不重复。
 */

interface PluginItem {
  id: string;
  name: string;
  category: string;
  subCategory?: string;
  requiresPositions?: boolean;
  description?: string;
  paramSchema: ParamField[];
  enabled: number;
  params: Record<string, unknown>;
}

export default function StrategyConfig() {
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  /** 组合策略（T133 / PA-08）：列表 + 编辑器开关 */
  const [combos, setCombos] = useState<ComboItem[]>([]);
  const [comboEditorOpen, setComboEditorOpen] = useState(false);
  const [editingCombo, setEditingCombo] = useState<ComboItem | null>(null);
  const [deletingCombo, setDeletingCombo] = useState<ComboItem | null>(null);
  /**
   * F6 / PRD U13：跨境 ETF 流动性提示
   *
   * 「编辑组合策略时提示一次」——`crossBorderHintShown` 保证**整个页面会话只弹一次**，
   * 用户点「知道了」后不再打扰；不阻塞保存，也不在下单时拦截。
   */
  const [crossBorderHintVisible, setCrossBorderHintVisible] = useState(false);
  const [crossBorderHintShown, setCrossBorderHintShown] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .get('/strategy/plugins')
      .then((res) => {
        if (isOkEnvelope(res.data)) setPlugins(res.data.data as PluginItem[]);
        else setError(String(res.data?.message ?? '加载失败'));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));

    // 组合接口失败不阻塞插件列表（老数据/未初始化时给空列表）
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

  /** 首次打开任一编辑器（插件参数 / 组合）时提示一次跨境流动性 */
  const maybeShowCrossBorderHint = () => {
    if (!crossBorderHintShown) {
      setCrossBorderHintShown(true);
      setCrossBorderHintVisible(true);
    }
  };

  /** 展开编辑：把当前 params 与 schema 默认值合并成草稿（与设置页同口径） */
  const openEditor = (p: PluginItem) => {
    const next: Record<string, unknown> = {};
    for (const f of p.paramSchema ?? []) {
      next[f.key] = p.params?.[f.key] !== undefined ? p.params[f.key] : paramDefault(f);
    }
    setDraft((d) => ({ ...d, [p.id]: next }));
    const opening = expanded !== p.id;
    setExpanded(opening ? p.id : null);
    if (opening) maybeShowCrossBorderHint();
    setMsg(null);
  };

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

  const toggle = async (p: PluginItem, enabled: boolean) => {
    setMsg(null);
    try {
      const res = await api.put(`/strategy/plugins/${encodeURIComponent(p.id)}/toggle`, { enabled });
      if (isOkEnvelope(res.data)) {
        setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled: enabled ? 1 : 0 } : x)));
        setMsg(`「${p.name}」已${enabled ? '启用' : '停用'}`);
      } else {
        setError(String(res.data?.message ?? '操作失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '操作失败'));
    }
  };

  const save = async (p: PluginItem) => {
    const params = draft[p.id] ?? {};
    // 前端范围校验；后端 pluginEngine 二次校验兜底（防绕过）
    const issue = validateParamValues(p.paramSchema ?? [], params);
    if (issue) {
      setError(`插件「${p.name}」的「${issue.label}」${issue.message}`);
      return;
    }
    setSaving(p.id);
    setError(null);
    try {
      const res = await api.put(`/strategy/plugins/${encodeURIComponent(p.id)}/config`, { params });
      if (isOkEnvelope(res.data)) {
        setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, params } : x)));
        setMsg(`已保存「${p.name}」参数`);
        setExpanded(null);
      } else {
        setError(String(res.data?.message ?? '保存失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '保存失败'));
    } finally {
      setSaving(null);
    }
  };

  const byCategory = useMemo(() => {
    const m = new Map<string, PluginItem[]>();
    for (const p of plugins) {
      const arr = m.get(p.category) ?? [];
      arr.push(p);
      m.set(p.category, arr);
    }
    return [...m.entries()];
  }, [plugins]);

  const selected = plugins.find((p) => p.id === expanded) ?? null;
  /** 条件候选：monitor 且非风险/组合级（后端 `isAllowedComboCondition` 同口径） */
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

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>策略配置</h1>
      {loading && <Spinner />}
      {error && <p style={errorStyle}>{error}</p>}
      {msg && <p style={{ color: COLORS.success, fontSize: TYPO.smallSize }}>{msg}</p>}

      {/* F6 / PRD U13：跨境 ETF 流动性提示（编辑插件参数或组合策略时提示一次） */}
      {crossBorderHintVisible && (
        <div
          role="status"
          data-testid="strategy-crossborder-hint"
          style={{
            background: COLORS.bgPillNeutral,
            border: `1px solid ${COLORS.borderPillNeutral}`,
            borderRadius: 4,
            padding: '8px 10px',
            marginBottom: SPACING.gapBase,
            fontSize: TYPO.smallSize,
            color: COLORS.textPillNeutral,
          }}
        >
          <b>跨境 ETF 提示</b>：跨境 ETF 在 A 股时段流动性受限。若组合策略适用于跨境 ETF，请把信号视为次日参考，
          避免在 A 股早盘追价。
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

      {/* 组合策略（T133 / PA-08）：MVP 只做 AND，strength 取最弱一环 */}
      {!loading && (
        <div data-testid="combos-section" style={{ ...cardStyle, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ ...subtitleStyle, margin: 0 }}>组合策略</h2>
            <button data-testid="combo-new" style={buttonStyle} onClick={() => openComboEditor(null)}>
              新建组合
            </button>
          </div>
          <p style={{ margin: '6px 0 8px', color: COLORS.textMuted, fontSize: TYPO.captionSize }}>
            组合 = 多个监控条件同时成立（AND）；整体强度取各条件中最弱的一环（min）。改动配置只影响未来信号。
          </p>

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
                        style={buttonStyle}
                        data-testid={`combo-edit-${combo.id}`}
                        onClick={() => openComboEditor(combo)}
                      >
                        编辑
                      </button>{' '}
                      <button
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
      )}

      {!loading &&
        byCategory.map(([cat, list]) => (
          <div key={cat} style={{ ...cardStyle, marginBottom: 16 }}>
            <h2 style={subtitleStyle}>
              {cat === 'monitor' ? '监控类策略' : cat === 'filter' ? '过滤类策略' : cat}
            </h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>策略</th>
                  <th style={thStyle}>说明</th>
                  <th style={thStyle}>启用</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <React.Fragment key={p.id}>
                    <tr>
                      <td style={tdStyle}>
                        {p.name}
                        <div style={{ color: COLORS.textMuted, fontSize: TYPO.captionSize }}>{p.id}</div>
                      </td>
                      <td style={{ ...tdStyle, color: COLORS.textMuted }}>{p.description ?? '—'}</td>
                      <td style={tdStyle}>
                        <input
                          type="checkbox"
                          checked={p.enabled === 1}
                          onChange={(e) => void toggle(p, e.target.checked)}
                          aria-label={`${p.name} 启用`}
                        />
                      </td>
                      <td style={tdStyle}>
                        <button style={buttonStyle} onClick={() => openEditor(p)}>
                          {expanded === p.id ? '收起参数' : '编辑参数'}
                        </button>
                      </td>
                    </tr>
                    {expanded === p.id && (
                      <tr>
                        <td colSpan={4} style={tdStyle}>
                          <PluginParamForm
                            pluginId={p.id}
                            schema={p.paramSchema ?? []}
                            values={draft[p.id] ?? {}}
                            idPrefix="strategy-config"
                            onChange={(key, value) =>
                              setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], [key]: value } }))
                            }
                          />
                          <div style={{ display: 'flex', gap: SPACING.gapBase }}>
                            <button
                              style={buttonStyle}
                              disabled={saving === p.id}
                              onClick={() => void save(p)}
                            >
                              {saving === p.id ? '保存中...' : '保存'}
                            </button>
                            <button
                              style={{ ...buttonStyle, background: COLORS.neutral }}
                              onClick={() => setExpanded(null)}
                            >
                              取消
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {selected && (
        <p style={{ color: COLORS.textMuted, fontSize: TYPO.captionSize }}>
          提示：现金类标的不会进入信号计算（后端 T133 已排除）。
        </p>
      )}

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

const subtitleStyle: React.CSSProperties = {
  fontSize: TYPO.cardTitleSize,
  fontWeight: 600,
  margin: '0 0 8px',
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: TYPO.smallSize,
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
