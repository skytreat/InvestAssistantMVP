// src/routes/strategy.ts
// T94（B-13 裁决：属 MVP）—— POST /api/strategy/reload 热加载自定义插件
//
// SDD §4.4:1383 是路由命名的唯一权威：`POST /api/strategy/reload`，鉴权「是（仅 admin）」。
// 另注册 `/api/strategy/plugins/reload` 别名，与 `/api/strategy/plugins`、`/api/strategy/plugins/:id/config`
// 归为同一族；两者行为完全一致（SDD 里没有的路径不留残路由，故别名只做兼容不做弃用标记）。
//
// 底层能力（services/pluginEngine.ts）本就已实装，本任务只补 HTTP 入口：
//   - PLUGIN_ALLOWED_PATH（/opt/invol/IA_Prod/plugins/strategies，AGENTS.md 口径，非 SDD §5.3 的 /opt/invest/）
//   - loadPluginsFromDir()：目录不存在 → 返回 []；单文件失败 try/catch 隔离，不影响其他插件
//   - createPluginSandbox()：Proxy 屏蔽 globalThis，global/process/require/fetch 等置 undefined
//
// ⚠️ 该引擎**没有插件缓存**：getAllPlugins() 每次都重新读目录，所以 reload 的语义就是
// 「立刻重新扫描目录」，无需清缓存（也无缓存可清）。

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import {
  PLUGIN_ALLOWED_PATH,
  createPluginSandbox,
  loadPluginsFromDir,
  type Plugin,
} from '../services/pluginEngine.js';
import { writeSystemLog } from '../services/logger.js';
import {
  DEFAULT_NOTIONAL,
  GROUP_BYS,
  HORIZONS,
  buildEffectivenessCsv,
  loadEffectivenessReport,
  type EvaluateOptions,
  type ExportLevel,
  type GroupBy,
  type Horizon,
} from '../services/strategyEffectiveness.js';
import { ok, fail } from '../lib/envelope.js';

/**
 * 与 pluginEngine.ts:584 的 PLUGIN_FILENAME_RE 同款正则。
 *
 * ⚠️ 这是**只读用途**的复刻（决定哪些文件进「加载失败明细」），不参与任何安全判定：
 * 真正的路径/文件名安全过滤在 loadPluginsFromDir 内部（正则 + statSync + resolved 前缀校验）。
 * 这里必须与引擎保持一致，否则「引擎跳过但我报成加载失败」的错误明细会出现噪音。
 */
const PLUGIN_FILENAME_RE = /^[a-z0-9_-]+\.js$/;

export interface ReloadPluginSummary {
  id: string;
  name: string;
  version: string;
  author: string;
  category: 'monitor' | 'filter';
}

export interface ReloadFailedEntry {
  file: string;
  error: string;
}

export interface ReloadResult {
  /** 磁盘插件目录（AGENTS.md 口径） */
  dir: string;
  /** 成功加载的插件数（目录不存在 = 0） */
  loaded: number;
  plugins: ReloadPluginSummary[];
  /** 单个插件加载失败明细；不影响其余插件加载 */
  errors: ReloadFailedEntry[];
}

interface AuthenticatedUser {
  sub: number;
  username: string;
  role: 'user' | 'admin';
}

function currentUser(request: FastifyRequest): AuthenticatedUser | null {
  const user = (request as FastifyRequest & { user?: AuthenticatedUser }).user;
  return user ?? null;
}

function summarize(plugin: Plugin): ReloadPluginSummary {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    author: plugin.author,
    category: plugin.category,
  };
}

/**
 * 重新扫描插件目录并归集每个文件的加载结果。
 *
 * 抽成独立函数（非仅 handler 内部逻辑）是为了让「语法错误文件不拖垮其他插件」
 * 「沙盒里 process/require 为 undefined」这些用例能在临时目录上直接验证
 * —— 生产路径 PLUGIN_ALLOWED_PATH 是 Linux 绝对路径，在开发机（Windows）上不存在。
 */
export function reloadPluginsFromDir(dirPath: string = PLUGIN_ALLOWED_PATH): ReloadResult {
  const plugins = loadPluginsFromDir(dirPath).map(summarize);
  const loadedIds = new Set(plugins.map((p) => p.id));

  // loadPluginsFromDir 对失败文件只 console.error，不回传原因；
  // 这里对「合法文件名但没出现在加载结果里」的文件重跑一次沙盒创建，把异常原因单列出来。
  const errors: ReloadFailedEntry[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return { dir: dirPath, loaded: plugins.length, plugins, errors };
  }

  for (const file of entries) {
    if (!PLUGIN_FILENAME_RE.test(file)) continue;
    const filePath = path.join(dirPath, file);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    try {
      const plugin = createPluginSandbox(fs.readFileSync(filePath, 'utf-8'));
      if (loadedIds.has(plugin.id)) continue;
      errors.push({ file, error: `插件 id「${plugin.id}」与已加载插件冲突` });
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { dir: dirPath, loaded: plugins.length, plugins, errors };
}

// ────────────────────────────────────────────────────────────────────────
// F4 Step B —— 策略有效性统计（`/api/strategy/effectiveness` + `/export`）
//
// 契约见 `docs/audit/proposal-strategy-effectiveness-f4.md` §7.2：
//   · 主口径 = 按信号 × 多周期 × 超额；绝对胜率并列
//   · 每条结果 / 每组汇总都带实际生效费率（否则结果之间不可比）
//   · sampleSize < 20 ⇒ insufficientSample = true，对外不输出百分比
// ────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BENCHMARK_RE = /^[a-z]{2}\d{6}$/;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 本地日期（避免 UTC 偏移把「今天」算成昨天） */
function todayLocal(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

interface ParsedEffectivenessQuery {
  options: EvaluateOptions;
  benchmark: string;
  pluginId?: string;
  origin?: string;
  level: ExportLevel;
}

type ParseResult = { ok: true; value: ParsedEffectivenessQuery } | { ok: false; code: string; message: string };

/**
 * 解析 + 校验查询参数（路由层）
 *
 * 非法参数一律 400，不把「静默降级」当成容错 —— 否则用户拿到的口径与预期不一致。
 */
function parseEffectivenessQuery(raw: Record<string, unknown>): ParseResult {
  const to = typeof raw.to === 'string' && raw.to ? raw.to : todayLocal();
  const from = typeof raw.from === 'string' && raw.from ? raw.from : addDays(to, -90);
  if (!DATE_RE.test(to) || !DATE_RE.test(from)) {
    return { ok: false, code: 'INVALID_DATE', message: 'from/to 必须为 YYYY-MM-DD' };
  }
  if (from > to) {
    return { ok: false, code: 'INVALID_RANGE', message: 'from 不能晚于 to' };
  }

  const horizonRaw = typeof raw.horizon === 'string' && raw.horizon ? raw.horizon.split(',') : HORIZONS;
  const horizons: Horizon[] = [];
  for (const h of horizonRaw) {
    const trimmed = h.trim();
    if (!HORIZONS.includes(trimmed as Horizon)) {
      return { ok: false, code: 'INVALID_HORIZON', message: `horizon 只支持 ${HORIZONS.join('/')}` };
    }
    if (!horizons.includes(trimmed as Horizon)) horizons.push(trimmed as Horizon);
  }

  const groupByRaw = typeof raw.group_by === 'string' && raw.group_by ? raw.group_by : 'plugin';
  if (!GROUP_BYS.includes(groupByRaw as GroupBy)) {
    return { ok: false, code: 'INVALID_GROUP_BY', message: `group_by 只支持 ${GROUP_BYS.join('/')}` };
  }

  const notionalRaw = typeof raw.notional === 'string' && raw.notional ? Number(raw.notional) : DEFAULT_NOTIONAL;
  if (!Number.isFinite(notionalRaw) || notionalRaw < 1_000 || notionalRaw > 100_000_000) {
    return { ok: false, code: 'INVALID_NOTIONAL', message: 'notional 必须在 1000 ~ 100000000 之间' };
  }

  const benchmark = typeof raw.benchmark === 'string' && raw.benchmark ? raw.benchmark : 'sh510300';
  if (!BENCHMARK_RE.test(benchmark)) {
    return { ok: false, code: 'INVALID_BENCHMARK', message: 'benchmark 格式非法' };
  }

  const levelRaw = typeof raw.level === 'string' && raw.level ? raw.level : 'detail';
  if (levelRaw !== 'summary' && levelRaw !== 'detail') {
    return { ok: false, code: 'INVALID_LEVEL', message: 'level 只支持 summary/detail' };
  }

  const pluginId = typeof raw.plugin_id === 'string' && raw.plugin_id ? raw.plugin_id : undefined;
  const origin = typeof raw.origin === 'string' && raw.origin ? raw.origin : undefined;

  return {
    ok: true,
    value: {
      options: {
        from,
        to,
        horizons,
        groupBy: groupByRaw as GroupBy,
        notional: notionalRaw,
        priceLimit: 0.1,
      },
      benchmark,
      pluginId,
      origin,
      level: levelRaw,
    },
  };
}

/**
 * POST /api/strategy/reload（+ 别名 /api/strategy/plugins/reload）
 *
 * 仅 admin。返回 { loaded, plugins, errors, dir }。
 * 目录不存在 → loaded:0 + errors:[]（不是 500）。
 */
export async function registerStrategyRoutes(app: FastifyInstance) {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = currentUser(request);
    if (!user || user.role !== 'admin') {
      return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可热加载插件'));
    }

    try {
      const result = reloadPluginsFromDir();
      writeSystemLog({
        logType: 'plugin_execute',
        level: result.errors.length > 0 ? 'WARN' : 'INFO',
        message: `${user.username} 热加载插件: loaded=${result.loaded} failed=${result.errors.length}`,
        detail: JSON.stringify({ dir: result.dir, errors: result.errors }),
      });
      return reply.code(200).send(ok(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'ERROR',
        message: `热加载插件失败: ${msg}`,
      });
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', msg));
    }
  };

  app.post('/api/strategy/reload', handler);
  app.post('/api/strategy/plugins/reload', handler);

  // T135（V3.4）信号后续表现：T+1/T+5/T+10 收盘价与涨跌幅（扣真实成本在前端/评估层处理）
  app.get('/api/strategy/signals/:id/outcome', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send(fail(400, 'INVALID_ID', 'id 非法'));
    const db = ConfigStore.getInstance().db;
    const sig = db
      .prepare(
        `SELECT asset_code, trade_date, direction, strength FROM user_strategy_signal WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      )
      .get(id, user.sub) as
      { asset_code: string; trade_date: string; direction: string; strength: number | null } | undefined;
    if (!sig) return reply.code(404).send(fail(404, 'NOT_FOUND', '信号不存在'));

    // 用 DuckDB 取该标的 trade_date 之后的 K 线（T+1/T+5/T+10）
    const { queryDuckDB } = await import('../db/duckdb.js');
    const rows = (await queryDuckDB<{ date: unknown; close: number }>(
      `SELECT date, "close" AS close FROM raw_kline_daily
        WHERE symbol = ? AND date > ? ORDER BY date ASC LIMIT 10`,
      [sig.asset_code, sig.trade_date],
    )) as Array<{ date: unknown; close: number }>;

    const baseRow = (await queryDuckDB<{ close: number }>(
      `SELECT "close" AS close FROM raw_kline_daily WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
      [sig.asset_code, sig.trade_date],
    )) as Array<{ close: number }>;
    const baseClose = baseRow[0]?.close ?? null;

    const outcome = (n: number) => {
      const r = rows[n - 1];
      if (!r || baseClose == null) return null;
      return {
        date: String(r.date).slice(0, 10),
        close: r.close,
        changePct: parseFloat((((r.close - baseClose) / baseClose) * 100).toFixed(2)),
      };
    };

    return reply.send(
      ok({
        signalId: id,
        asset_code: sig.asset_code,
        trade_date: sig.trade_date,
        direction: sig.direction,
        baseClose,
        t1: outcome(1),
        t5: outcome(5),
        t10: outcome(10),
      }),
    );
  });

  // ── F4 Step B：有效性统计（只读；不改 F1 分级 / 风险过滤 / 候选集）────────
  app.get('/api/strategy/effectiveness', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));

    const parsed = parseEffectivenessQuery(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send(fail(400, parsed.code, parsed.message));

    try {
      const report = await loadEffectivenessReport(user.sub, {
        ...parsed.value.options,
        pluginId: parsed.value.pluginId,
        origin: parsed.value.origin,
        benchmark: parsed.value.benchmark,
      });
      return reply.send(ok(report));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'ERROR',
        message: `策略有效性统计失败: ${msg}`,
      });
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', '策略有效性统计失败'));
    }
  });

  /**
   * CSV 导出（默认 detail）
   *
   * 约定抄 I8（`brokerReconcile.ts`）：UTF-8 BOM + CRLF、文件名白名单 + 日期戳。
   * **每行都带费率列**，报告正文（每行 `fee_model_label`）即口径标识。
   */
  app.get('/api/strategy/effectiveness/export', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));

    const parsed = parseEffectivenessQuery(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send(fail(400, parsed.code, parsed.message));

    try {
      const report = await loadEffectivenessReport(user.sub, {
        ...parsed.value.options,
        pluginId: parsed.value.pluginId,
        origin: parsed.value.origin,
        benchmark: parsed.value.benchmark,
      });
      const csv = buildEffectivenessCsv(report, parsed.value.level);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="strategy-effectiveness-${parsed.value.options.from}-${parsed.value.options.to}-${parsed.value.level}.csv"`,
        )
        .send(csv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'ERROR',
        message: `策略有效性导出失败: ${msg}`,
      });
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', '策略有效性导出失败'));
    }
  });
}
