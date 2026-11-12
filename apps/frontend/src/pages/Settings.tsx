import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { COLORS, RADIUS, TYPO } from '../theme/tokens';
import { pageContainerStyle, cardStyle, titleStyle, cardTitleStyle } from './_shared';
import PluginManager from '../components/PluginManager';
import ComboSection from '../components/ComboSection';

/**
 * 设置页 `/settings`（2026-11-12 起合并原「策略配置」页 `/strategy/config`）
 *
 * 页内三个分区（Tab）：
 * ① 插件管理 —— 插件列表 + 启停 + 参数编辑（唯一实现 `components/PluginManager`）
 * ② 组合策略 —— 组合 CRUD（`components/ComboSection`）
 * ③ 合规声明 —— 隐私声明（PRD §5.9 要求常驻设置页）+ 关于
 *
 * 合并原因：原 Settings 与 StrategyConfig 两页的插件启停/参数保存是**两份重复实现**
 *（且已漂移：一个保存后重新拉取、一个只改本地 state），移动端底部 Tab 也进不了
 * 原 /strategy/config。路由 `?tab=plugins|combos|compliance` 支持直达分区。
 */

type TabKey = 'plugins' | 'combos' | 'compliance';

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'plugins', label: '插件管理' },
  { key: 'combos', label: '组合策略' },
  { key: 'compliance', label: '合规声明' },
];

function isValidTab(raw: string | null): raw is TabKey {
  return raw === 'plugins' || raw === 'combos' || raw === 'compliance';
}

const tabButtonBase: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: TYPO.smallSize,
  fontFamily: TYPO.fontFamily,
  borderRadius: RADIUS.base,
  border: `1px solid ${COLORS.borderMedium}`,
  background: COLORS.cardBg,
  color: COLORS.textSecondary,
  cursor: 'pointer',
};

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    ...tabButtonBase,
    ...(active
      ? {
          background: COLORS.bgSelectedPrimary,
          border: `1px solid ${COLORS.borderSelectedPrimary}`,
          color: COLORS.brandLink,
          fontWeight: 700,
        }
      : {}),
  };
}

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: TabKey = isValidTab(rawTab) ? rawTab : 'plugins';

  const switchTab = (next: TabKey) => {
    // 默认分区不带 query（/settings 即「插件管理」），其余分区写进 URL 便于直达
    setSearchParams(next === 'plugins' ? {} : { tab: next });
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>设置</h1>

      <div
        role="tablist"
        aria-label="设置分区"
        style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            style={tabButtonStyle(tab === t.key)}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'plugins' && <PluginManager />}

      {tab === 'combos' && <ComboSection />}

      {tab === 'compliance' && (
        <>
          {/*
            PRD §5.9「隐私声明常驻（注册页 + 设置页）」——**逐字要点**：
              「不收集手机号、位置、社交账号等多余个人信息」
              「仅存储交易数据和行情相关数据」
            ⚠️ 位置要求：**设置页独立区块**（不是「关于」卡片里的一句，也不是全局合规条）。
            插件安全承诺在「插件管理」分区内（`PluginManager`），本分区只放隐私声明。
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
              {/*
                ⚠️ ADR-018（2026-11-12）后此文案必须与代码一致：
                校验 WARN/ERROR **不再自动补跑** tdx2db（增量语义下必为空跑），
                只记录 + 告警 + 人工处理；补跑仅保留「更新成功但无数据」一支。
              */}
              <div>数据校验：每日 C1-C12，异常记录并告警（不再自动补跑，见 ADR-018）</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
