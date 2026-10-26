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

  /** 展开编辑：把当前 params 与 schema 默认值合并成草稿（与设置页同口径） */
  const openEditor = (p: PluginItem) => {
    const next: Record<string, unknown> = {};
    for (const f of p.paramSchema ?? []) {
      next[f.key] = p.params?.[f.key] !== undefined ? p.params[f.key] : paramDefault(f);
    }
    setDraft((d) => ({ ...d, [p.id]: next }));
    setExpanded(expanded === p.id ? null : p.id);
    setMsg(null);
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

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>策略配置</h1>
      {loading && <Spinner />}
      {error && <p style={errorStyle}>{error}</p>}
      {msg && <p style={{ color: COLORS.success, fontSize: TYPO.smallSize }}>{msg}</p>}

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
          提示：现金类标的不会进入信号计算（后端 T133 已排除）；组合策略（多条件开关）待 V3.8 T148 后续细化。
        </p>
      )}
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
