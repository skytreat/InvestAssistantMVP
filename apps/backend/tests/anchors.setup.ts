/**
 * 🔒 **锚点套件的环境守卫（必须真库，环境不对就红灯）**
 *
 * 只在 `vitest.anchors.config.ts` 里挂载（日常套件不加载本文件）。
 *
 * 为什么不再用 `it.skipIf(!SCALE_READY)`：
 *   `*anchors.test.ts` 是**手动跑的门禁**，断言的是真库规模与具体历史日期上的数值。
 *   守卫若是「静默 skip」，手跑时环境没配对（忘了 `DUCKDB_PATH`、指向迷你库/空壳库）
 *   会得到 **0 失败** 的假绿 —— 而这正是这次拆分的初衷要避免的。
 *   ⇒ 这里在**任何测试文件被求值之前**直接抛错，让整轮红掉。
 *
 * 🔴 **档位强制覆盖（2026-11-07 方案 A）**：
 *   日常 `tests/setup.ts` 已默认把 `MARKET_DATA_MODE` 置为 `ci`（日常套件绝不打开真库）。
 *   anchors 必须真库 ⇒ 这里**显式覆盖为 `full`**。
 *   ⚠️ 必须在 `_marketData.ts` **被求值之前**写进 `process.env` ——
 *      该模块在模块体里就 `resolveMarketData()` 并缓存 `_resolved`，晚一步就锁死档位。
 *      故**不能用静态 import**（静态 import 会被提升到模块体之前），改为动态 import。
 *
 * 判定口径与 `_marketData.ts` 一致：
 *   ① 档位必须是 `full`（`MARKET_DATA_MODE=full` + `DUCKDB_PATH` 指向真库）；
 *   ② 真库必须**探测可用**（有 `v_stock_qfq` 表且有数据）—— 空壳库文件存在但不可用。
 */
process.env.MARKET_DATA_MODE = 'full';

const { marketDataTier, marketDataUsableFor } = await import('./_marketData.js');

const tier = marketDataTier();

if (tier !== 'full') {
  throw new Error(
    [
      '[anchors.setup] ❌ 锚点套件需要**真库**，当前档位是 ' + tier + '。',
      '  这些用例断言真库规模/具体历史日期上的数值，迷你库与空壳库都撑不起。',
      '  修法：在仓库根 `.env.local` 里配置 DUCKDB_PATH 指向真库（1.24GB），',
      '        或在命令行显式覆盖：',
      '          PowerShell: $env:DUCKDB_PATH="D:/workspace/InvestAssistantMVP/data/quotes.duckdb"; npm run test:anchors -w @invest/backend',
      '        并确认 MARKET_DATA_MODE 未被测试文件改成 mini / ci。',
    ].join('\n'),
  );
}

const usable = await marketDataUsableFor('scale');
if (!usable) {
  throw new Error(
    '[anchors.setup] ❌ 真库探测失败（v_stock_qfq 无数据或文件打不开）。' +
      '请确认 DUCKDB_PATH 指向有效真库文件、且没有后端进程独占写锁。',
  );
}
