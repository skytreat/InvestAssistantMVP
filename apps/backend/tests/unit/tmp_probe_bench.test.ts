process.env.DUCKDB_PATH = '/opt/invol/quotes.duckdb';
process.env.MARKET_DATA_MODE = 'full';
import { it } from 'vitest';
import { queryDuckDB } from '../../src/db/duckdb.js';

it('probe benchmark momentum distribution', async () => {
  // sh000300 是策略市场过滤用的基准（指数轨）；sh510300 是 ETF 轨超额基准
  for (const sym of ['sh000300', 'sh510300']) {
    const r = await queryDuckDB(
      `WITH bars AS (
         SELECT date, close,
                lag(close) OVER (ORDER BY date) AS prev
         FROM raw_kline_daily WHERE symbol = ? AND date BETWEEN '2018-01-01' AND '2026-11-06'
       ), w25 AS (
         SELECT date, close,
                AVG(close) OVER (ORDER BY date ROWS BETWEEN 24 PRECEDING AND CURRENT ROW) AS ma25,
                COUNT(*) OVER (ORDER BY date ROWS BETWEEN 24 PRECEDING AND CURRENT ROW) AS n
         FROM bars
       )
       SELECT COUNT(*) AS n,
              SUM(CASE WHEN close < ma25 THEN 1 ELSE 0 END) AS below_ma25,
              MIN(close/ma25 - 1) AS min_rel_ma25,
              AVG(close/ma25 - 1) AS avg_rel_ma25,
              SUM(CASE WHEN close/ma25 - 1 < -0.05 THEN 1 ELSE 0 END) AS below_ma25_5pct
       FROM w25 WHERE n = 25`,
      [sym],
    );
    console.log(`BENCH ${sym}`, JSON.stringify((r as any[])[0]));
  }
  // 再看 25 日动量（WSM 的近似）与 60 日动量
  for (const sym of ['sh000300', 'sh510300']) {
    const r2 = await queryDuckDB(
      `WITH bars AS (
         SELECT date, close FROM raw_kline_daily WHERE symbol = ? AND date BETWEEN '2018-01-01' AND '2026-11-06'
       ), m AS (
         SELECT date, close,
                close / FIRST_VALUE(close) OVER (ORDER BY date ROWS BETWEEN 24 PRECEDING AND CURRENT ROW) - 1 AS ret25,
                close / FIRST_VALUE(close) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) - 1 AS ret60,
                COUNT(*) OVER (ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS n
         FROM bars
       )
       SELECT SUM(CASE WHEN ret25 < 0 THEN 1 ELSE 0 END) AS neg25,
              SUM(CASE WHEN ret60 < 0 THEN 1 ELSE 0 END) AS neg60,
              COUNT(*) AS total, MIN(ret25) AS min25
       FROM m WHERE n = 60`,
      [sym],
    );
    console.log(`MOM ${sym}`, JSON.stringify((r2 as any[])[0]));
  }
}, 300000);
