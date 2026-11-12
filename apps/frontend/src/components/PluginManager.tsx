import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { extractErrorMessage } from '../api/errors';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import PluginParamForm, { paramDefault, validateParamValues, type ParamField } from './PluginParamForm';

/**
 * 插件管理（从 StrategyConfig / Settings 两页抽出的**唯一一份**实现，2026-11-12 合并）
 *
 * 职责：
 * ① 插件列表按分类（监控/过滤）展示
 * ② 启用/停用开关（PUT /api/strategy/plugins/:id/toggle）
 * ③ 参数具名编辑（paramSchema 驱动 PluginParamForm）
 * ④ PRD §5.9「插件安全承诺」常驻插件管理区
 *
 * ⚠️ 此前 Settings 与 StrategyConfig 各有一份几乎相同的 load/toggle/save 逻辑
 *（且已漂移：一个保存后重新拉取、一个只改本地 state）——本组件是收敛后的唯一实现。
 */

export interface PluginItem {
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

export default function PluginManager() {
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  /**
   * F6 / PRD U13：跨境 ETF 流动性提示
   * 「编辑插件参数时提示一次」——`crossBorderHintShown` 保证本组件会话只弹一次。
   */
  const [crossBorderHintVisible, setCrossBorderHintVisible] = useState(false);
  const [crossBorderHintShown, setCrossBorderHintShown] = useState(false);

  const maybeShowCrossBorderHint = () => {
    if (!crossBorderHintShown) {
      setCrossBorderHintShown(true);
      setCrossBorderHintVisible(true);
    }
  };

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
  }, []);

  const byCategory = useMemo(() => {
    const groups = new Map<string, PluginItem[]>();
    for (const p of plugins) {
      const list = groups.get(p.category) ?? [];
      list.push(p);
      groups.set(p.category, list);
    }
    // 保持插件返回顺序（监控类在前），不按 category 字母序 ——
    // 页内「编辑参数」按钮的顺序依赖于此（测试与用户习惯都以监控类为第一组）
    return [...groups.entries()];
  }, [plugins]);

  /** 展开编辑：把当前 params 与 schema 默认值合并成草稿 */
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

  const toggle = async (p: PluginItem, enabled: boolean) => {
    setMsg(null);
    try {
      const res = await api.put(
        `/strategy/plugins/${encodeURIComponent(p.id)}/toggle`,
        // 后端 `enabled` 只收 0/1（与旧设置页/策略配置页同口径，保持契约不变）
        { enabled: enabled ? 1 : 0 },
      );
      if (isOkEnvelope(res.data)) {
        setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled: enabled ? 1 : 0 } : x)));
        setMsg(`已${enabled ? '启用' : '停用'}「${p.name}」`);
      } else {
        setError(String(res.data?.message ?? '操作失败'));
      }
    } catch (e) {
      setError(extractErrorMessage(e, '操作失败'));
    }
  };

  const save = async (p: PluginItem) => {
    const params = draft[p.id] ?? {};
    // 前端范围校验；后端 pluginEngine 还有校验兜底（防绕过）
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

  const subtitleStyle: React.CSSProperties = {
    fontSize: TYPO.cardTitleSize,
    fontWeight: 600,
    margin: '0 0 8px',
  };

  return (
    <div>
      {/* F6 / PRD U13：跨境 ETF 流动性提示（编辑参数时提示一次，不阻塞保存） */}
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
      {error && (
        <div style={{ color: COLORS.danger, fontSize: TYPO.smallSize, marginBottom: 8 }}>{error}</div>
      )}
      <div aria-live="polite" aria-busy={loading}>
        {msg && (
          <div style={{ color: COLORS.textSuccess, fontSize: TYPO.smallSize, marginBottom: 8 }}>{msg}</div>
        )}
      </div>
      <div
        style={{
          border: `1px solid ${COLORS.borderLight}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: SPACING.gapRelaxed,
        }}
      >
        <div style={{ fontWeight: TYPO.cardTitleWeight, fontSize: 15, marginBottom: 8 }}>策略插件</div>
        {/*
         * PRD §5.9「插件安全承诺」——逐字要点：
         *   「所有插件禁止包含荐股、资金托管、实盘对接功能」
         *   「自定义插件默认执行超时保护，防止异常代码影响主流程」
         * 该承诺属于**插件管理区域**（不能挪到页脚或全局合规条）。
         */}
        <div
          data-testid="plugin-security-notice"
          style={{
            background: COLORS.bgDisclaimer,
            color: COLORS.textDisclaimer,
            borderRadius: 6,
            padding: '8px 12px',
            marginBottom: 12,
            fontSize: TYPO.smallSize,
            lineHeight: 1.8,
          }}
        >
          所有插件禁止包含荐股、资金托管、实盘对接功能；自定义插件默认执行超时保护，防止异常代码影响主流程。
        </div>
        {loading && <div style={{ color: COLORS.neutral, padding: 8 }}>加载中…</div>}
        {!loading && plugins.length === 0 && (
          <div style={{ color: COLORS.neutral, padding: 8 }}>暂无可用插件</div>
        )}
        {!loading &&
          byCategory.map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 12 }}>
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
                          <button
                            type="button"
                            style={buttonStyle}
                            onClick={() => openEditor(p)}
                            disabled={(p.paramSchema?.length ?? 0) === 0}
                          >
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
                              idPrefix="settings"
                              onChange={(key, value) =>
                                setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], [key]: value } }))
                              }
                            />
                            <div style={{ display: 'flex', gap: SPACING.gapBase, marginTop: 8 }}>
                              <button
                                type="button"
                                style={buttonStyle}
                                disabled={saving === p.id}
                                onClick={() => void save(p)}
                              >
                                {saving === p.id ? '保存中...' : '保存'}
                              </button>
                              <button
                                type="button"
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
      </div>

      {/*
       * 现金类标的不参与信号计算（后端 T133 resolveSignalSymbols 已排除）——
       * 在插件管理区给出提示，避免用户误以为组合/信号覆盖全部持仓。
       */}
      <div style={{ fontSize: TYPO.captionSize, color: COLORS.textMuted }}>
        提示：现金类标的不会进入信号计算（后端已排除）。
      </div>
    </div>
  );
}
