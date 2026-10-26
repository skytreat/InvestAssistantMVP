import type { FastifyInstance } from 'fastify';
import { ok, fail } from '../lib/envelope.js';
import { computePortfolioReturn } from '../services/portfolioReturn.js';

export async function registerPortfolioRoutes(app: FastifyInstance) {
  app.get('/api/portfolio/return', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const q = request.query as { brokerCode?: string };
    try {
      const r = await computePortfolioReturn(user.sub, q?.brokerCode?.trim() || undefined);
      return reply.send(ok(r));
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
}
