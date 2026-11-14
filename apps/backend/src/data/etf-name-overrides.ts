/**
 * ETF 名称覆盖表 —— 修复 tdx2db 写入 raw_symbol_name 时末字 U+FFFD 损坏
 *
 * 键 = 原始坏名（含 \uFFFD 替换符），值 = 正确名。
 * 由 `npx tsx scripts/export-etf-bad-names.ts` 导出待补全清单，人工补全后写回本文件。
 *
 * 使用：
 *   import { ETF_NAME_OVERRIDES } from '../../data/etf-name-overrides.js';
 *   const fixed = ETF_NAME_OVERRIDES.get(rawName) ?? rawName;
 */
import raw from './etf-name-overrides.json';

export const ETF_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map(
  Object.entries(raw as Record<string, string>),
);
