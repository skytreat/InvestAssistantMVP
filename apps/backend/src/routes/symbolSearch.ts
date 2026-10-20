import type { FastifyInstance } from 'fastify';
import { queryDuckDB } from '../db/duckdb.js';
import { ok, fail } from '../lib/envelope.js';

/**
 * 标的搜索接口（SDD §5.5 选股页 autocomplete）
 *
 * GET /api/symbols/search?q=600000
 * 返回模糊匹配的标的列表（最多 20 条），带中文名
 * 用于前端输入框 autocomplete
 */
interface SymbolRow {
  symbol: string;
  name: string;
}

export async function registerSymbolSearchRoutes(app: FastifyInstance) {
  app.get('/api/symbols/search', async (request, reply) => {
    const { q = '' } = request.query as { q?: string };
    const keyword = String(q).trim();

    if (keyword.length === 0) {
      return reply.send(ok([]));
    }

    // 支持：纯数字（600000）、带前缀（sh600000）、中文名模糊匹配
    // LIKE 用双 % 同时匹配 symbol 和 name
    try {
      const rows = await queryDuckDB<SymbolRow>(
        `SELECT symbol, name FROM raw_symbol_name
         WHERE symbol LIKE ? OR name LIKE ?
         ORDER BY symbol
         LIMIT 20`,
        [`%${keyword}%`, `%${keyword}%`],
      );

      return reply.send(ok(rows));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err, keyword }, 'symbol search failed');
      return reply.code(500).send(fail(500, 'SEARCH_FAILED', msg));
    }
  });
}
