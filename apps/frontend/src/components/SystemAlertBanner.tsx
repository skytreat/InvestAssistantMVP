import React from 'react';
import { Link } from 'react-router-dom';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';

export interface SystemAlertBannerProps {
  /** 今日行情链路失败的说明（空数组 = 不渲染） */
  messages: string[];
}

/**
 * 管理端 Dashboard 顶部红色告警条。
 *
 * 数据来源：`/admin/system-log` 当日 `tdx2db_update` / `datacheck` 的 ERROR 终态
 * （由 `Dashboard.tsx` 过滤后传入）。非 admin 或当日无 ERROR 时不渲染。
 */
export default function SystemAlertBanner({ messages }: SystemAlertBannerProps) {
  if (messages.length === 0) return null;

  return (
    <div
      role="alert"
      data-testid="dashboard-system-alert"
      style={{
        backgroundColor: COLORS.danger,
        border: `1px solid ${COLORS.danger}`,
        borderRadius: RADIUS.base,
        color: COLORS.cardBg,
        fontSize: TYPO.bodySize,
        lineHeight: 1.6,
        marginBottom: SPACING.cardMarginBottom,
        padding: `${SPACING.gapBase} ${SPACING.cardPadding}`,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: SPACING.gapTight }}>今日行情链路异常</div>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      <div style={{ fontSize: TYPO.smallSize, marginTop: SPACING.gapTight }}>
        <Link to="/admin?tab=logs" style={{ color: COLORS.cardBg, textDecoration: 'underline' }}>
          查看系统日志
        </Link>
      </div>
    </div>
  );
}
