import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import Spinner from '../components/Spinner';
import PluginParamForm, {
  paramDefault,
  validateParamValues,
  type ParamField,
} from '../components/PluginParamForm';
import {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  buttonStyle,
  errorStyle,
  successStyle,
} from './_shared';

/**
 * ⚠️ `ParamField`（后端 paramSchema 契约）与参数表单渲染器已抽到
 *    `components/PluginParamForm.tsx`（T73 · F-S2）——
 *    本页与 `pages/StockScan.tsx`（选股页）**共用同一个 schema 驱动渲染器**，
 *    避免两份实现随时间漂移（控件类型映射 / 范围提示 / 必填标记）。
 */
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

/**
 * 「合规 / 承诺」提示条样式
 *
 * ⚠️ 复用既有的 `bgDisclaimer` / `textDisclaimer` 色板（**不新增裸 hex**）——
 *    深琥珀文字（#92400e）在浅琥珀底上的对比度 6.8:1 ≥ 4.5:1。
 */
const noticeStyle: React.CSSProperties = {
  background: COLORS.bgDisclaimer,
  color: COLORS.textDisclaimer,
  borderRadius: RADIUS.base,
  padding: '8px 12px',
  marginBottom: 12,
  fontSize: TYPO.smallSize,
  lineHeight: 1.8,
};

/**
 * 插件「启用 / 禁用」开关的 checkbox id（T63）
 *
 * 与参数字段 id 命名空间隔离（用 `plugin-` 前缀），避免与同名参数 key 撞 id。
 */
function pluginToggleId(pluginId: string): string {
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `settings-${sanitize(pluginId)}-plugin-enabled`;
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
    } catch (err) {
      setError(extractErrorMessage(err, '加载失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

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
    // ⚠️ T73：校验规则已抽到 `components/PluginParamForm.tsx` 的 `validateParamValues`
    //    （与选股页共用），错误文案与改动前逐字一致。
    const issue = validateParamValues(p.paramSchema ?? [], params);
    if (issue) {
      setError(`插件「${p.name}」的「${issue.label}」${issue.message}`);
      return;
    }

    setSaving(p.id);
    setError(null);
    try {
      await api.post(`/strategy/plugins/${p.id}/config`, { params });
      setMsg(`已保存「${p.name}」参数`);
      setExpanded(null);
      await load();
    } catch (err) {
      setError(extractErrorMessage(err, '保存失败'));
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
    } catch (err) {
      setError(extractErrorMessage(err, '操作失败'));
    }
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>设置</h1>

      {/*
       * 异步结果的播报区（T76 ⑤ · aria-live）
       *
       * ⚠️ **`aria-live` 必须挂在「常驻」的容器上** —— 若挂在条件渲染出来的节点上，
       *    读屏在内容变化时该节点还不存在 ⇒ 播报不会触发（与 Dashboard / Candidates 的同款做法）。
       * ⚠️ `successStyle` 里的 `COLORS.success` 是**饱和图形档**（白底 3.30:1）——
       *    `theme/styles.ts` 属卡 4 的地盘（不在本卡改动范围），故在**使用点**覆盖成
       *    正文色档 `textSuccess`（白底 5.02:1 ✅）。
       */}
      <div aria-live="polite" aria-busy={loading}>
        {error && <div style={errorStyle}>{error}</div>}
        {msg && <div style={{ ...successStyle, color: COLORS.textSuccess }}>{msg}</div>}
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>策略插件</div>
        {/*
         * PRD §5.9「插件安全承诺」——**逐字要点**（不是改写）：
         *   「所有插件禁止包含荐股、资金托管、实盘对接功能」
         *   「自定义插件默认执行超时保护，防止异常代码影响主流程」
         * ⚠️ 这条承诺属于**插件管理区域**，故落在本卡片内（不是页脚、也不是全局合规条）。
         */}
        <div style={noticeStyle} data-testid="plugin-security-notice">
          所有插件禁止包含荐股、资金托管、实盘对接功能；自定义插件默认执行超时保护，防止异常代码影响主流程。
        </div>
        {loading && <Spinner />}
        {!loading && plugins.length === 0 && (
          <div style={{ color: COLORS.neutral, padding: 16 }}>暂无可用插件</div>
        )}
        {!loading &&
          plugins.map((p) => (
            <div
              key={p.id}
              style={{
                border: `1px solid ${COLORS.borderLight}`,
                borderRadius: RADIUS.base,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: TYPO.cardTitleWeight, fontSize: 15 }}>
                    {p.name}
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        padding: '1px 6px',
                        borderRadius: 10,
                        background:
                          p.category === 'monitor' ? COLORS.bgSelectedPrimary : COLORS.bgSelectedPurple,
                        color: p.category === 'monitor' ? COLORS.brandLink : COLORS.textSelectedPurple,
                      }}
                    >
                      {CATEGORY_LABEL[p.category] ?? p.category}
                    </span>
                  </div>
                  {p.description && (
                    <div style={{ fontSize: TYPO.smallSize, color: COLORS.neutral, marginTop: 2 }}>
                      {p.description}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                    <code>{p.id}</code>
                  </div>
                </div>
                <label
                  style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                >
                  {/* 包住式 label（label 内含唯一的 checkbox）→ 天然关联，无需 htmlFor */}
                  <input
                    id={pluginToggleId(p.id)}
                    type="checkbox"
                    checked={p.enabled === 1}
                    onChange={() => toggle(p)}
                  />
                  {p.enabled === 1 ? '已启用' : '已禁用'}
                </label>
                {(p.paramSchema?.length ?? 0) > 0 && (
                  <button style={buttonStyle} onClick={() => openEditor(p)}>
                    {expanded === p.id ? '收起参数' : '参数配置'}
                  </button>
                )}
              </div>

              {expanded === p.id && (
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: `1px solid ${COLORS.borderSubtle}`,
                  }}
                >
                  {/*
                    T73 · F-S2：参数表单改用共享的 schema 驱动渲染器
                    `components/PluginParamForm.tsx`（与选股页共用）。
                    ⚠️ `runtimeInjected` 的参数（如 symbol）由后端运行时注入，
                    不该作为用户可配置项出现在表单里 —— 组件内部已按该标记过滤。
                  */}
                  <PluginParamForm
                    pluginId={p.id}
                    schema={p.paramSchema ?? []}
                    values={draft[p.id] ?? {}}
                    idPrefix="settings"
                    onChange={(key, value) =>
                      setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], [key]: value } }))
                    }
                  />
                  <div style={{ display: 'flex', gap: SPACING.gapBase }}>
                    <button style={buttonStyle} disabled={saving === p.id} onClick={() => save(p)}>
                      {saving === p.id ? '保存中...' : '保存'}
                    </button>
                    <button
                      style={{ ...buttonStyle, background: COLORS.neutral }}
                      onClick={() => setExpanded(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
      </div>

      {/*
        PRD §5.9「隐私声明常驻（注册页 + 设置页）」——**逐字要点**：
          「不收集手机号、位置、社交账号等多余个人信息」
          「仅存储交易数据和行情相关数据」
        ⚠️ 位置要求：**设置页独立区块**（不是「关于」卡片里的一句，也不是全局合规条）。
        ⚠️ 注册页（`pages/Login.tsx`）的那一份**不在本卡改动范围**（见交付报告的遗留项）。
      */}
      <div style={cardStyle}>
        <div style={cardTitleStyle}>隐私声明</div>
        <div
          style={{ fontSize: TYPO.bodySize, lineHeight: 1.9, color: COLORS.textSecondary }}
          data-testid="privacy-notice"
        >
          <div>本工具不收集手机号、位置、社交账号等多余个人信息；仅存储交易数据和行情相关数据。</div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>关于</div>
        <div style={{ fontSize: TYPO.bodySize, lineHeight: 1.9, color: COLORS.textSecondary }}>
          <div>InvestAssistant MVP — 个人股票管理 + 策略信号系统</div>
          <div>行情数据：通达信本地日线（DuckDB 行情层，只读）</div>
          <div>数据校验：每日 C1-C12 三层防线，WARN 自动补跑</div>
          {/*
            T95：此处原有的合规声明文案是全局合规声明的**重复**，
            且与 PRD §5.9 的逐字原文不一致（多了一个限定词）→ 已删除。
            全局合规声明统一由 App.tsx 的 `<footer>`（`components/ComplianceFooter.tsx`）渲染，
            文案逐字取自 PRD §5.9。
            ⚠️ PRD §5.9 的「隐私声明常驻（注册页 + 设置页）」与「插件安全承诺（设置页插件区）」
            属 T76 ⑥ —— 本卡（Wave 7 卡 5）已在**上方两个独立区块**落地（设置页部分）；
            注册页（`pages/Login.tsx`）部分不在本卡改动范围。
          */}
        </div>
      </div>
    </div>
  );
}
