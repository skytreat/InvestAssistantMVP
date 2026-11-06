import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { isOkEnvelope } from '../api/envelope';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { pageContainerStyle, cardStyle, titleStyle, cardTitleStyle } from './_shared';
import AdminBackupPanel from '../components/AdminBackupPanel';
import AdminLogPanel from '../components/AdminLogPanel';
import AdminRolePanel from '../components/AdminRolePanel';
import AdminTriggerPanel from '../components/AdminTriggerPanel';
import DatacheckCards from '../components/DatacheckCards';

/**
 * 管理员面板（Wave 7 · T75 · 卡 6 接线收口；UX-09 分区）
 *
 * ## 页面只做「布局 + 分区切换 + 接线」
 *
 * UX-09 之前这里是超长单页（校验卡 / 触发 / 备份 / 角色 / 日志 一路平铺），
 * 要看到日志底部必须滚过前面所有模块。现在拆成 5 个分区，`?tab=` 可深链：
 *
 * | tab | 分区 | 组件 |
 * |---|---|---|
 * | `check`（默认）| 数据校验 | `DatacheckCards`（自带卡片外框与标题）|
 * | `trigger` | 手动触发 | `AdminTriggerPanel`（不带外框）|
 * | `backup` | 备份与恢复 | `AdminBackupPanel`（不带外框）|
 * | `roles` | 角色管理 | `AdminRolePanel`（不带外框）|
 * | `logs` | 系统日志 | `AdminLogPanel`（自带卡片外框与标题）|
 *
 * ## 分层约定
 *
 * - 页面**管布局**（分区导航 + 卡片外框），组件**管内容**；
 * - 组件**不 import 本页面**（只认 props）；
 * - 只有当前分区挂载 —— 切到「备份」不会顺带请求日志/角色，避免无关请求；
 * - 各组件保留自己的 loading / error 状态，切换分区不丢校验刷新（`checksRefreshKey` 在页面层）。
 */

/** 5 个分区（顺序 = 导航顺序） */
const TABS = [
  { key: 'check', label: '数据校验' },
  { key: 'trigger', label: '手动触发' },
  { key: 'backup', label: '备份与恢复' },
  { key: 'roles', label: '角色管理' },
  { key: 'logs', label: '系统日志' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function isTabKey(value: string | null): value is TabKey {
  return TABS.some((t) => t.key === value);
}

export default function Admin() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: TabKey = isTabKey(tabParam) ? tabParam : 'check';

  /**
   * 校验卡片的刷新计数
   *
   * 手动触发校验 / 补跑行情之后，`AdminTriggerPanel` 会回调 `onChecksRefreshed`
   * ⇒ 计数 +1 ⇒ `DatacheckCards` 重新拉一次 `GET /admin/datacheck/result`。
   */
  const [checksRefreshKey, setChecksRefreshKey] = useState(0);
  const [latestQuoteDate, setLatestQuoteDate] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/market/latest-date');
        if (cancelled) return;
        if (isOkEnvelope(res.data)) {
          const d = (res.data.data as { date?: string | null } | null)?.date ?? null;
          setLatestQuoteDate(d);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const handleChecksRefreshed = useCallback(() => {
    setChecksRefreshKey((k) => k + 1);
  }, []);

  const selectTab = (key: TabKey) => {
    setParams({ tab: key }, { replace: true });
  };

  return (
    <div style={pageContainerStyle}>
      <h1 style={titleStyle}>管理员面板</h1>
      {latestQuoteDate && (
        <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>最新行情日期：{latestQuoteDate}</div>
      )}

      {/* 分区导航：窄屏自动换行，键盘可 Tab 遍历 */}
      <div role="tablist" aria-label="管理员分区" style={tabListStyle}>
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`admin-tab-${t.key}`}
              aria-selected={active}
              aria-controls={`admin-panel-${t.key}`}
              onClick={() => selectTab(t.key)}
              style={active ? activeTabStyle : tabStyle}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'check' && (
        <div role="tabpanel" id="admin-panel-check" aria-labelledby="admin-tab-check">
          {/*
            ⚠️ `DatacheckCards` **自带卡片外框与卡片标题**（与旧页面文案逐字一致），
               故这里不再套一层 `cardStyle`（避免双层边框）。
          */}
          <DatacheckCards refreshKey={checksRefreshKey} />
        </div>
      )}

      {tab === 'trigger' && (
        <div role="tabpanel" id="admin-panel-trigger" aria-labelledby="admin-tab-trigger">
          {/*
            ⚠️ `AdminTriggerPanel` **不带外框** ⇒ 外框与标题由本页提供。
          */}
          <div style={cardStyle}>
            <div style={cardTitleStyle}>手动触发</div>
            <AdminTriggerPanel onChecksRefreshed={handleChecksRefreshed} />
          </div>
        </div>
      )}

      {tab === 'backup' && (
        <div role="tabpanel" id="admin-panel-backup" aria-labelledby="admin-tab-backup">
          {/*
            ⚠️ `AdminBackupPanel` **不带外框** ⇒ 外框与标题由本页提供。
            UX-10：危险恢复区已从日常备份表中拆出，在本面板内部独立成区。
          */}
          <div style={cardStyle}>
            <div style={cardTitleStyle}>备份与恢复</div>
            <AdminBackupPanel />
          </div>
        </div>
      )}

      {tab === 'roles' && (
        <div role="tabpanel" id="admin-panel-roles" aria-labelledby="admin-tab-roles">
          {/*
            ⚠️ `AdminRolePanel` **不带外框** ⇒ 外框与标题由本页提供。
          */}
          <div style={cardStyle}>
            <div style={cardTitleStyle}>角色管理</div>
            <AdminRolePanel />
          </div>
        </div>
      )}

      {tab === 'logs' && (
        <div role="tabpanel" id="admin-panel-logs" aria-labelledby="admin-tab-logs">
          {/*
            ⚠️ `AdminLogPanel` **自带卡片外框与 `<h2>` 标题**，故这里不再套一层 `cardStyle`。
          */}
          <AdminLogPanel pageSize={20} />
        </div>
      )}
    </div>
  );
}

/** 分区导航容器 */
const tabListStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: SPACING.gapTight,
  marginBottom: SPACING.gapBase,
  paddingBottom: SPACING.gapTight,
  borderBottom: `1px solid ${COLORS.borderLight}`,
};

/** 未选中的分区按钮 */
const tabStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: TYPO.bodySize,
  color: COLORS.textSecondary,
  background: 'transparent',
  border: `1px solid ${COLORS.borderLight}`,
  borderRadius: RADIUS.sm,
  cursor: 'pointer',
};

/** 选中的分区按钮（品牌色描边 + 浅底，不用彩色底白字） */
const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  color: COLORS.brand,
  border: `1px solid ${COLORS.brand}`,
  background: COLORS.headerBg,
  fontWeight: 600,
};
