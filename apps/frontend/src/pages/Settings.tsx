import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  inputStyle,
  buttonStyle,
  errorStyle,
  successStyle,
  labelStyle,
} from './_shared';

/** 后端 ParamField 契约（apps/backend/src/services/pluginEngine.ts） */
interface ParamField {
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

interface PluginItem {
  id: string;
  name: string;
  category: string;
  description?: string;
  paramSchema?: ParamField[];
  enabled: number;
  params: Record<string, unknown>;
}

const CATEGORY_LABEL: Record<string, string> = {
  monitor: '监控信号',
  filter: '条件选股',
};

/** 参数默认值：用户没存过就用 schema 默认值 */
function paramDefault(field: ParamField): unknown {
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'number' || field.type === 'integer') return field.min ?? 0;
  if (field.type === 'select') return field.options?.[0] ?? '';
  return '';
}

export default function Settings() {
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  /** 展开参数表单的插件 id */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 编辑中的参数草稿：pluginId → params */
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/strategy/plugins');
      if (res.data.success) setPlugins(res.data.data ?? []);
      else setError(res.data.message ?? '加载失败');
    } catch (err: any) {
      setError(err?.response?.data?.message ?? '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openEditor = (p: PluginItem) => {
    const next: Record<string, unknown> = {};
    for (const f of p.paramSchema ?? []) {
      next[f.key] = p.params?.[f.key] !== undefined ? p.params[f.key] : paramDefault(f);
    }
    setDraft((d) => ({ ...d, [p.id]: next }));
    setExpanded(expanded === p.id ? null : p.id);
    setMsg(null);
  };

  const save = async (p: PluginItem) => {
    const params = draft[p.id] ?? {};
    // 前端做一遍范围校验，后端 pluginEngine 仍会二次校验（防绕过）
    for (const f of p.paramSchema ?? []) {
      const v = params[f.key];
      if (f.required && (v === '' || v === undefined || v === null)) {
        setError(`插件「${p.name}」的「${f.label}」为必填`);
        return;
      }
      if ((f.type === 'number' || f.type === 'integer') && v !== '' && v !== undefined && v !== null) {
        const num = Number(v);
        if (Number.isNaN(num)) {
          setError(`插件「${p.name}」的「${f.label}」必须是数字`);
          return;
        }
        if (f.min !== undefined && num < f.min) {
          setError(`插件「${p.name}」的「${f.label}」不能小于 ${f.min}`);
          return;
        }
        if (f.max !== undefined && num > f.max) {
          setError(`插件「${p.name}」的「${f.label}」不能大于 ${f.max}`);
          return;
        }
      }
    }

    setSaving(p.id);
    setError(null);
    try {
      await api.post(`/strategy/plugins/${p.id}/config`, { params });
      setMsg(`已保存「${p.name}」参数`);
      setExpanded(null);
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? '保存失败');
    } finally {
      setSaving(null);
    }
  };

  const toggle = async (p: PluginItem) => {
    const next = p.enabled ? 0 : 1;
    setError(null);
    try {
      await api.post(`/strategy/plugins/${p.id}/toggle`, { enabled: next });
      setMsg(`已${next ? '启用' : '禁用'}「${p.name}」`);
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? '操作失败');
    }
  };

  const renderField = (p: PluginItem, f: ParamField) => {
    const value = draft[p.id]?.[f.key] ?? '';
    const set = (v: unknown) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], [f.key]: v } }));

    return (
      <div key={f.key} style={{ marginBottom: 12 }}>
        <label style={{ ...labelStyle, display: 'block', minWidth: 0, marginBottom: 4 }}>
          {f.label}
          {f.required && <span style={{ color: '#dc2626' }}> *</span>}
          {f.unit && <span style={{ color: '#6b7280', fontSize: 12 }}>（{f.unit}）</span>}
        </label>
        {f.type === 'boolean' && (
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />
            {' '}启用该选项
          </label>
        )}
        {f.type === 'select' && (
          <select style={{ ...inputStyle, width: '100%' }} value={String(value)} onChange={(e) => set(e.target.value)}>
            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        {(f.type === 'number' || f.type === 'integer') && (
          <input
            type="number"
            style={{ ...inputStyle, width: '100%' }}
            value={value === '' || value === undefined ? '' : String(value)}
            min={f.min}
            max={f.max}
            step={f.step ?? (f.type === 'integer' ? 1 : 'any')}
            onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))}
          />
        )}
        {f.type === 'string' && (
          <input style={{ ...inputStyle, width: '100%' }} value={String(value)}
            onChange={(e) => set(e.target.value)} />
        )}
        {(f.min !== undefined || f.max !== undefined) && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            允许范围：{f.min ?? '-∞'} ~ {f.max ?? '+∞'}
          </div>
        )}
        {f.description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{f.description}</div>}
      </div>
    );
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>设置</h1>

      {error && <div style={errorStyle}>{error}</div>}
      {msg && <div style={successStyle}>{msg}</div>}

      <div style={cardStyle}>
        <div style={cardTitleStyle}>策略插件</div>
        {loading && <div>加载中...</div>}
        {!loading && plugins.length === 0 && (
          <div style={{ color: '#6b7280', padding: 16 }}>暂无可用插件</div>
        )}
        {!loading && plugins.map((p) => (
          <div key={p.id} style={{
            border: '1px solid #e5e7eb', borderRadius: 6, padding: 12, marginBottom: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  {p.name}
                  <span style={{
                    marginLeft: 8, fontSize: 12, padding: '1px 6px', borderRadius: 10,
                    background: p.category === 'monitor' ? '#dbeafe' : '#ede9fe',
                    color: p.category === 'monitor' ? '#1e40af' : '#5b21b6',
                  }}>
                    {CATEGORY_LABEL[p.category] ?? p.category}
                  </span>
                </div>
                {p.description && (
                  <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{p.description}</div>
                )}
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                  <code>{p.id}</code>
                </div>
              </div>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={p.enabled === 1} onChange={() => toggle(p)} />
                {p.enabled === 1 ? '已启用' : '已禁用'}
              </label>
              {(p.paramSchema?.length ?? 0) > 0 && (
                <button style={buttonStyle} onClick={() => openEditor(p)}>
                  {expanded === p.id ? '收起参数' : '参数配置'}
                </button>
              )}
            </div>

            {expanded === p.id && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
                {/* T85b ①：runtimeInjected 的参数（如 symbol）由后端运行时注入，
                    不该作为用户可配置项出现在表单里 */}
                {(p.paramSchema ?? []).filter((f) => !f.runtimeInjected).map((f) => renderField(p, f))}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={buttonStyle} disabled={saving === p.id} onClick={() => save(p)}>
                    {saving === p.id ? '保存中...' : '保存'}
                  </button>
                  <button style={{ ...buttonStyle, background: '#6b7280' }} onClick={() => setExpanded(null)}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>关于</div>
        <div style={{ fontSize: 14, lineHeight: 1.9, color: '#374151' }}>
          <div>InvestAssistant MVP — 个人股票管理 + 策略信号系统</div>
          <div>行情数据：通达信本地日线（DuckDB 行情层，只读）</div>
          <div>数据校验：每日 C1-C12 三层防线，WARN 自动补跑</div>
          <div style={{ color: '#92400e', marginTop: 8 }}>本工具不构成投资建议，所有数据仅供参考</div>
        </div>
      </div>
    </div>
  );
}