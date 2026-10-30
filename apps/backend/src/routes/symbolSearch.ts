import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { queryDuckDB } from '../db/duckdb.js';
import { ok, fail } from '../lib/envelope.js';
import { ensureSymbolDict, searchSymbolDict } from '../services/symbolDict.js';

interface SymbolRow {
  symbol: string;
  name: string;
  code6?: string;
  pinyin?: string;
  market?: string;
  asset_class?: string;
  matchType?: string;
}

export async function registerSymbolSearchRoutes(app: FastifyInstance) {
  app.get('/api/symbols/search', async (request, reply) => {
    const { q = '' } = request.query as { q?: string };
    const keyword = String(q).trim();

    if (keyword.length === 0) {
      return reply.send(ok([]));
    }

    try {
      const snapshotCount = await ensureSymbolDict();
      if (snapshotCount > 0) {
        // 快照已就绪：无论是否命中都只查业务层，**不再回退 DuckDB**。
        // 否则每次「无匹配」都会打开行情库，既慢又会把 CI 空库变成 500。
        const db = ConfigStore.getInstance().db;
        const rows = searchSymbolDict(db, keyword, 20);
        return reply.send(
          ok(
            rows.map((r) => ({
              symbol: r.symbol,
              code6: r.code6,
              name: r.name,
              market: r.market,
              asset_class: r.asset_class,
              pinyin: r.pinyin,
              matchType: 'code',
            })),
          ),
        );
      }
      // 快照为空（CI 无行情库 / 首次同步失败）时回退 DuckDB
      const fallback = await queryDuckDB<SymbolRow>(
        `SELECT symbol, name FROM raw_symbol_name
         WHERE symbol LIKE ? OR name LIKE ?
         ORDER BY symbol LIMIT 20`,
        [`%${keyword}%`, `%${keyword}%`],
      );
      return reply.send(ok(fallback));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err, keyword }, 'symbol search failed');
      return reply.code(500).send(fail(500, 'SEARCH_FAILED', msg));
    }
  });
}
