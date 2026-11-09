/**
 * K 线形态识别 —— 对外唯一入口
 *
 * ⚠️ 硬约束（`docs/client/pattern_recognition_design.md` §9）：
 *   本模块只服务**图上标注**；不得被 `pluginEngine` / `signalService` / `routes/signal` 引用，
 *   不写信号表、不输出 direction、不进 F1 / Top5 / paper。
 */
export {
  buildZigZag,
  findRawPivots,
  filterPivotsByDeviation,
  DEFAULT_DEPTH,
  DEFAULT_DEVIATION_PCT,
  type PivotType,
  type ZigZagOptions,
  type ZigZagPoint,
} from './zigzag.js';
export { calculateATR, DEFAULT_ATR_PERIOD } from './atr.js';
export {
  detectDoubleTopBottom,
  DEFAULT_PATTERN_OPTIONS,
  type PatternAnnotation,
  type PatternBreakout,
  type PatternKind,
  type PatternMetrics,
  type PatternNeckline,
  type PatternOptions,
  type PatternPoint,
  type ResolvedPatternOptions,
} from './reversal.js';
export {
  detectHeadShoulders,
  DEFAULT_HEAD_SHOULDER_OPTIONS,
  type HeadShoulderAnnotation,
  type HeadShoulderKind,
  type HeadShoulderMetrics,
  type HeadShoulderOptions,
  type HeadShoulderPoint,
  type HeadShoulderRole,
  type ResolvedHeadShoulderOptions,
} from './headShoulder.js';
