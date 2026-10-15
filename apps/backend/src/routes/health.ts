import type { FastifyInstance } from 'fastify';

/**
 * 健康检查（无需鉴权）
 * 前端 Vite proxy 轮询这个接口
 */
export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (request, reply) => {
    reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '0.1.0',
    });
  });
}
