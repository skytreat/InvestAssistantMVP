import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ConfigStore } from './config/configStore.js';
import { duckdbHealthCheck } from './db/duckdb.js';
import { registerRoutes } from './routes/index.js';

/**
 * Fastify 后端入口
 * MVP 硬约束：只监听 127.0.0.1，CORS 只允许 127.0.0.1
 * 端口固定 8080（AGENTS.md 端口分配）
 */

const HOST = '127.0.0.1';
const PORT = 8080;

async function bootstrap() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: undefined,  // MVP 用默认 pino 输出到 stdout，systemd journal 自动捕获
    },
  });

  // CORS 硬约束：只允许 localhost
  await app.register(cors, {
    origin: [`http://127.0.0.1:5173`, `http://localhost:5173`],
    credentials: true,
  });

  // 初始化 ConfigStore（SQLite + DDL）
  const config = ConfigStore.getInstance();
  app.log.info(`SQLite 初始化完成: ${config.getDbPath()}`);

  // 注册路由
  await registerRoutes(app);

  // DuckDB 连接健康检查（不阻塞启动——DuckDB 文件可能还没初始化）
  try {
    await duckdbHealthCheck();
    app.log.info('DuckDB 行情库连接正常');
  } catch (err) {
    app.log.warn({ err }, 'DuckDB 暂不可用（tdx2db 可能还没 init），不阻塞启动');
  }

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Fastify 监听 ${HOST}:${PORT}`);
  } catch (err) {
    app.log.error({ err }, 'Fastify 启动失败');
    process.exit(1);
  }
}

// 优雅退出
process.on('SIGTERM', async () => {
  console.log('收到 SIGTERM，正在关闭...');
  process.exit(0);
});

bootstrap();
