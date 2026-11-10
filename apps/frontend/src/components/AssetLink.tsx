import React from 'react';
import { Link } from 'react-router-dom';
import { COLORS, TYPO } from '../theme/tokens';

/**
 * 标的展示（名称优先 + 代码副行），整体链接到 K 线页。
 *
 * - 名称来自 `/api/review/*` 的 `asset_name`（行情层 `raw_symbol_name`，缺失是常态）；
 *   查不到时回退显示代码，不显示空行。
 * - K 线路由是 `/kline`（无路径参数），用 `?symbol=` 传标的（`pages/Kline.tsx` 消费该 query）。
 */
export function klineHref(assetCode: string): string {
  return `/kline?symbol=${encodeURIComponent(assetCode)}`;
}

export interface AssetLinkProps {
  assetCode: string;
  assetName?: string | null;
  /**
   * `stacked`（默认）= 名称主行 + 代码副行；
   * `inline` = 名称(代码) 单行，用于信号 / 有效性等表格。
   */
  variant?: 'stacked' | 'inline';
}

export default function AssetLink({ assetCode, assetName, variant = 'stacked' }: AssetLinkProps) {
  const name = typeof assetName === 'string' ? assetName.trim() : '';
  if (variant === 'inline') {
    const label = name ? `${name}(${assetCode})` : assetCode;
    return (
      <Link to={klineHref(assetCode)} title={`查看 ${label} K线`} style={inlineLinkStyle}>
        {label}
      </Link>
    );
  }
  const label = name || assetCode;
  return (
    <Link to={klineHref(assetCode)} title={`查看 ${label}（${assetCode}）K线`} style={linkStyle}>
      <span style={nameStyle}>{label}</span>
      {name && <span style={codeStyle}>{assetCode}</span>}
    </Link>
  );
}

const linkStyle: React.CSSProperties = {
  color: COLORS.brandLink,
  textDecoration: 'none',
  display: 'inline-block',
};

const inlineLinkStyle: React.CSSProperties = {
  color: COLORS.brandLink,
  textDecoration: 'none',
};

const nameStyle: React.CSSProperties = {
  display: 'block',
  fontWeight: 500,
};

const codeStyle: React.CSSProperties = {
  display: 'block',
  fontSize: TYPO.captionSize,
  color: COLORS.textMuted,
};
