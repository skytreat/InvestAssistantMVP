import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { queryDuckDB } from '../db/duckdb.js';
import { ok, fail } from '../lib/envelope.js';
import { ensureSymbolDict, searchSymbolDict } from '../services/symbolDict.js';
import { batchGetSymbolNames } from '../services/marketData.js';

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

  /**
   * GET /api/symbols/names?symbols=sh600000,sz000001
   *
   * 批量取标的名称（前端「名称(代码)」展示用）。名称是装饰信息：
   * 任一来源不可用 / 代码无名称时该 key 缺省，前端回退为仅显示代码，**不返回 500**。
   *
   * 先查 `symbol_dict` 快照（快、覆盖有名称的全市场）；仍缺的代码再回退一次行情库
   * （快照为空 / 新股未同步的场景）。
   */
  app.get('/api/symbols/names', async (request, reply) => {
    const raw = (request.query as { symbols?: string }).symbols ?? '';
    const symbols = Array.from(
      new Set(
        String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ).slice(0, 200);
    if (symbols.length === 0) return reply.send(ok({}));

    const names: Record<string, string> = {};
    let snapshotReady = false;
    try {
      const db = ConfigStore.getInstance().db;
      // 快照已就绪：缺失代码一律视为「无名称」，不再回退行情库
      // （与 /api/symbols/search 同口径，避免每次缺失都打开行情库）。
      snapshotReady = Boolean(db.prepare('SELECT 1 FROM symbol_dict LIMIT 1').get());
      const placeholders = symbols.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT symbol, name FROM symbol_dict WHERE symbol IN (${placeholders})`)
        .all(...symbols) as Array<{ symbol: string; name: string | null }>;
      for (const row of rows) {
        const name = typeof row.name === 'string' ? row.name.trim() : '';
        if (name.length > 0) names[row.symbol] = name;
      }
    } catch {
      // 快照不可用时走行情库兜底
    }

    const missing = symbols.filter((symbol) => names[symbol] === undefined);
    if (!snapshotReady && missing.length > 0) {
      try {
        const fallback = await batchGetSymbolNames(missing);
        for (const [symbol, name] of fallback) names[symbol] = name;
      } catch {
        // 行情库不可用时仅返回快照命中的名称
      }
    }

    return reply.send(ok(names));
  });
}
