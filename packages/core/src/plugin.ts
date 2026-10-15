/**
 * 插件相关纯类型定义（core 包零业务依赖，只放数据契约）
 *
 * MVP 说明：
 * - DailyKline 被 apps/backend/services/marketData.ts import，作为双端日线结构统一契约
 * - Plugin / PluginContext / PluginSignal / ParamField 等**插件执行接口**
 *   在 apps/backend/src/services/pluginEngine.ts 有增强版定义（动态行情查询 + 沙盒执行上下文）
 *   core 包不定义插件执行接口——纯算法层不关心"怎么执行插件"
 */

/** 日线结构（双端统一契约） */
export interface DailyKline {
  date: string;       // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}
