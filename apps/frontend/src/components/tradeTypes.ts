/**
 * 交易类型的**单一真相源**（T68 / T69 共用）
 *
 * 🔴 **为什么单独建这个模块**（2026-10-20 实测）：
 * 7 种交易类型的中文名此前**散落在 4 个文件**且**互相矛盾**：
 *
 * | 文件 | 旧值 | 应为 |
 * |---|---|---|
 * | `pages/TradeInput.tsx` | 转托管 | **转增** |
 * | `pages/Review.tsx` | 转增 | 转增 ✅ |
 * | `components/TodayActivityCard.tsx` | 转增 | 转增 ✅ |
 * | `components/PositionDetailModal.tsx` | 转股 | **转增** |
 *
 * ⇒ 同一笔交易在不同页面显示成三种名字，是**面向用户的数据一致性缺陷**。
 *
 * **权威依据**：`docs/client/Requirements_simplified.md` §5.1 的 7 种交易类型
 * （买入 / 加仓 / 减仓 / 清仓 / **分红 / 送股 / 转增**）。
 * ⚠️ 注意 §5.1 **没有「卖出」** —— 部分卖出 = `reduce`（减仓）、全部卖出 = `clear`（清仓）。
 * （实施计划 **DEC-2** 已裁决「移除 `sell`、加入 `add`」；后端 DDL CHECK 与 `TRADE_TYPES` 同源。）
 */

/** 后端 `TRADE_TYPES` 的 7 种类型（与 `routes/trade.ts` 的导出 + DDL CHECK 一致）*/
export const TRADE_TYPES = ['buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer'] as const;

export type TradeType = (typeof TRADE_TYPES)[number];

/** 7 种类型的中文标签（§5.1 口径）*/
export const TRADE_TYPE_LABEL: Record<TradeType, string> = {
  buy: '买入',
  add: '加仓',
  reduce: '减仓',
  clear: '清仓',
  dividend: '分红',
  bonus: '送股',
  transfer: '转增',
};

/**
 * 交易的语义说明（PRD §5.4 / Requirements §5.1 的「部分卖出 / 全部卖出」口径）。
 * 用于 tooltip 与 aria 说明，避免用户把 `reduce` 理解成「卖出」。
 */
export const TRADE_TYPE_HINT: Record<TradeType, string> = {
  buy: '新开买入：增加数量 + 移动加权成本',
  add: '追加买入：增加数量 + 移动加权成本',
  reduce: '部分卖出：减少数量（不超持仓），成本不变',
  clear: '全部卖出：数量减至 0，成本重置',
  dividend: '现金分红：股息入账',
  bonus: '送股：红股入账，同比例稀释（均价不变）',
  transfer: '转增：转增股入账，同比例稀释（均价不变）',
};

/** 是否为「用户主动」交易（系统自动导入的三类不要求填理由）*/
export const USER_INITIATED_TRADE_TYPES: TradeType[] = ['buy', 'add', 'reduce', 'clear'];

/** 是否为「减仓/清仓」（需校验持仓充足性）*/
export const REDUCE_TRADE_TYPES: TradeType[] = ['reduce', 'clear'];

/** 是否为「系统自动导入」类型（理由由系统固化）*/
export const AUTO_IMPORT_TRADE_TYPES: TradeType[] = ['dividend', 'bonus', 'transfer'];

/** 取中文标签；未知类型回落到原值（不吞掉信息）*/
export function tradeTypeLabel(type: string): string {
  return TRADE_TYPE_LABEL[type as TradeType] ?? type;
}
