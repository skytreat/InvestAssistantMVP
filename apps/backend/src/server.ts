import Fastify from 'fastify';
import cors from '@fastify/cors';
import schedule from '@fastify/schedule';
import { ConfigStore } from './config/configStore.js';
import { duckdbHealthCheck } from './db/duckdb.js';
import { registerRoutes } from './routes/index.js';
import { registerCronJobs } from './services/scheduler.js';

/**
 * Fastify 后端入口
 * MVP 硬约束：只监听 127.0.0.1，CORS 只允许 127.0.0.1
 * 默认端口 8080（AGENTS.md 端口分配）；PORT 可覆盖（docs/deploy.md §3 的环境变量表已按可配置书写），
 * 用途是避开宿主上已占用 8080 的其他服务（如本机的 llama-server），默认行为不变。
 */

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8080);

async function bootstrap() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: undefined, // MVP 用默认 pino 输出到 stdout，systemd journal 自动捕获
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

  // 注册 @fastify/schedule + 4 段 cron（校验 / 信号 / 除权 / 备份）
  // 本地开发可用 DISABLE_CRON=1 跳过（行情数据已预置，不跑定时更新）
  if (process.env.DISABLE_CRON !== '1') {
    await app.register(schedule);
    registerCronJobs(app);
    app.log.info('Cron 任务已注册（17:01 校验 / 17:02 信号 / 17:03 除权 / 17:05 备份）');
  } else {
    app.log.warn('DISABLE_CRON=1 — 跳过 cron 注册');
  }

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
  const { closeDuckDBInstance } = await import('./db/duckdb.js');
  await closeDuckDBInstance();
  process.exit(0);
});

bootstrap();
