/**
 * 组合求值（T133，PA-03）—— 纯函数，不读库、不碰插件上下文
 *
 * 口径（方案 §6，owner 已定）：
 * - **D1：MVP 只做 AND** —— 所有启用条件同向成立才出信号；混合方向不成立；
 * - **D2：strength = min(各启用条件 strength)** —— 最弱一环决定整体可信度；
 * - 条件失败 / 跳过 / 缺方向 ⇒ 该标的本轮不成立（不把异常当成"成立"）；
 * - 启用条件少于 2 个 ⇒ 不成立（组合语义要求"多个条件同时成立"）。
 *
 * 求值器只消费调用方传入的**单个标的结果集**；批量/落库由后续 PA-06 负责。
 */

export type ComboDirection = 'BUY' | 'SELL';

export type ComboConditionStatus = 'OK' | 'SKIP' | 'ERROR' | 'TIMEOUT';

/** 单个条件在某个标的上的执行结果（由组合执行器从 `executePlugin` 的结果映射） */
export interface ComboConditionResult {
  pluginId: string;
  /** 条件开关（INV-S3-19）；false 时整条条件不参与求值 */
  enabled: boolean;
  /** 缺省视为 `'OK'`（便于只关心方向的调用方） */
  status?: ComboConditionStatus;
  /** 插件输出的方向；`HOLD` 或空值 ⇒ 视为不成立 */
  signalType?: ComboDirection | 'HOLD' | null;
  /** 0~1；缺失或越界 ⇒ 不成立（无法计算 min） */
  strength?: number | null;
}

export interface ComboMatch {
  direction: ComboDirection;
  /** 各启用条件 strength 的最小值 */
  strength: number;
  /** 决定 min 的条件（用于解释"哪一条拖低了强度"） */
  minPluginId: string;
  matchedPluginIds: string[];
}

function isValidStrength(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * AND + min 求值
 *
 * @returns 成立时返回方向与强度；否则 `null`
 */
export function evaluateCombo(results: readonly ComboConditionResult[]): ComboMatch | null {
  const enabled = results.filter((result) => result.enabled);
  if (enabled.length < 2) {
    return null;
  }

  let direction: ComboDirection | null = null;
  let strength = 1;
  let minPluginId = '';
  const matchedPluginIds: string[] = [];

  for (const result of enabled) {
    const status = result.status ?? 'OK';
    if (status !== 'OK') {
      return null;
    }
    if (result.signalType !== 'BUY' && result.signalType !== 'SELL') {
      return null;
    }
    if (!isValidStrength(result.strength)) {
      return null;
    }
    if (direction === null) {
      direction = result.signalType;
    } else if (direction !== result.signalType) {
      // 混合方向 ⇒ AND 不成立
      return null;
    }
    matchedPluginIds.push(result.pluginId);
    if (result.strength < strength) {
      strength = result.strength;
      minPluginId = result.pluginId;
    } else if (minPluginId === '') {
      minPluginId = result.pluginId;
    }
  }

  if (direction === null) {
    return null;
  }
  return { direction, strength, minPluginId, matchedPluginIds };
}
