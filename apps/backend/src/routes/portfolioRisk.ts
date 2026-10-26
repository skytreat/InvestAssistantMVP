import type { FastifyInstance } from 'fastify';
import { ok, fail } from '../lib/envelope.js';
import { computeRiskCheck } from '../services/portfolioRisk.js';

export async function registerPortfolioRiskRoutes(app: FastifyInstance) {
  app.get('/api/portfolio/risk-check', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    try {
      const r = await computeRiskCheck(user.sub);
      return reply.send(ok(r));
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
}
