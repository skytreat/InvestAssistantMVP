/**
 * ETF 名称覆盖表 —— 修复 tdx2db 写入 raw_symbol_name 时末字截断产生的 U+FFFD 损坏
 *
 * 键 = 标的代码（含市场前缀，如 `sh510900`，与 `raw_symbol_name.symbol` / 业务层 asset_code 一致）；
 * 值 = 官方名称（权威源：天天基金 fund.eastmoney.com 基金代码全量列表）。
 *
 * 🔴 键不用坏名：坏名本身是损坏数据（含 U+FFFD），且同一坏名可对应多个标的代码
 *    （实测 395 个坏名标的中 23 个坏名各有 2+ 代码，按坏名键丢失映射）。
 * 由 `npx tsx scripts/complete-etf-bad-names.ts` 重新生成（需行情库可读 + 网络）。
 *
 * 使用：
 *   import { ETF_NAME_OVERRIDES } from '../../data/etf-name-overrides.js';
 *   const fixed = ETF_NAME_OVERRIDES.get(symbol) ?? rawName;
 */
import raw from './etf-name-overrides.json';

export const ETF_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map(
  Object.entries(raw as Record<string, string>),
);
