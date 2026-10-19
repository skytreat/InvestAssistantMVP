/**
 * RSI 实现已迁移至 `fast-technical-indicators@1.1.6`（T51）。
 *
 * 本文件保留为**兼容转发**，避免既有 import 路径失效；
 * 算法不在这里 —— 见 `adapters.ts`。
 * 新代码请直接 `import { calculateRSI } from '@invest/core'`。
 */
export { calculateRSI, RSI_DEFAULT_PERIOD } from './adapters';