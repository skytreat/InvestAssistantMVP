import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';

import { getLatestMarketSnapshot } from '../services/marketData.js';
import { CHECK_IDS, CHECK_NAMES } from '../services/validator.js';
import { ok, fail } from '../lib/envelope.js';
import { defaultMessage } from '../lib/errorMessages.js';

/**
 * 数据校验 API（T29 补充）
 * - GET  /api/admin/datacheck/result    → 最近一次 C1-C12 校验结果（结构化 summaries）
 * - POST /api/datacheck/run             → 手动触发 C1-C12 并立即返回结果
 * - GET  /api/market/latest             → 行情最新几行（需 DuckDB）
 */

/** 校验结果的四种状态（PRD §5.7「四色」的取值域） */
type ResultState = 'PASS' | 'WARN' | 'ERROR' | 'SKIP';

/**
 * `system_log.level` → 四态结果的映射
 *
 * ⚠️ **为什么需要映射**：`validator.ts` 的 `logResult()` 把 `PASS` 落库成 **`SUCCESS`**
 *   （`system_log.level` 的白名单是 `INFO/WARN/ERROR/SKIP/SUCCESS`，没有 `PASS`）。
 *   但接口对外的口径必须是四态（`PASS/WARN/ERROR/SKIP`）——
 *   PRD §5.7 的「四色（PASS=绿 / WARN=黄 / ERROR=红 / SKIP=灰）」用的就是这四个词，
 *   `CheckResult` 类型（validator.ts）也是这四个。
 *   ⇒ 落库用 `SUCCESS`，出库用 `PASS`，**两套词各自在自己的层内自洽**。
 */
const LEVEL_TO_RESULT: Record<string, ResultState> = {
  SUCCESS: 'PASS',
  PASS: 'PASS',
  WARN: 'WARN',
  ERROR: 'ERROR',
  SKIP: 'SKIP',
};

/** 落库 level → 四态（未知 level 归为 SKIP：数据源不可用 ≠ 校验通过） */
function toResultState(level: string | null | undefined): ResultState {
  if (!level) return 'SKIP';
  return LEVEL_TO_RESULT[level] ?? 'SKIP';
}

/**
 * 判断字符串是否是**真实存在的日历日期**（`YYYY-MM-DD`）
 *
 * 🔴 **为什么必须严格校验**（Wave 7 · 卡 3 · 缺口 X-2）：
 *   开发库 `data/business.db` 的 `system_log` 里，`log_type='datacheck'` 的
 *   `MAX(log_date)` 是 **`2026-99-99`** —— 它来自
 *   `apps/backend/tests/unit/validator.test.ts` 里 `runAllChecks('2026-99-99')` 的写入。
 *   原实现用 `MAX(log_date)` 定位「最近一次校验」⇒ 被这条假日期劫持。
 *
 *   `2026-99-99` 之所以能通过 SQLite，是因为 **SQLite 的 `date()` 会把越界字段规范化**
 *   （`date('2026-02-30')` → `'2026-03-02'`）—— 不能依赖 SQLite 自己判日历。
 *   故这里在 JS 里做「格式 + 逐字段 + Date 回环」三重校验。
 */
function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number(part));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  // 回环校验：Date 会把 2 月 30 日规范化成 3 月 2 日 ⇒ 往返不相等即不是真实日期
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

export async function registerDataCheckRoutes(app: FastifyInstance) {
  // 最近一次校验结果（结构化）
  app.get('/api/admin/datacheck/result', async (request, reply) => {
    // 🔴 Wave 7 · 卡 3 · 裁决 D-10：补 role 校验（admin 专属）
    //   此前该端点**只有全局 token 校验** → 任何登录用户都能读校验结果，
    //   而 G7.4 要求「普通用户访问**全部** admin 端点均 403」。
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    try {
      const db = ConfigStore.getInstance().db;

      // ── ① 定位「最近一次**真实**校验日」 ────────────────────────────
      // ⚠️ 不再用 `MAX(log_date)`（会被 `2026-99-99` 这类假日期劫持）；
      //   改为：取全部候选日期 → 过滤出**真实日历日且不晚于今天** → 取最大者。
      const today = new Date().toISOString().slice(0, 10);
      const dateRows = db
        .prepare(
          `SELECT DISTINCT log_date FROM system_log
           WHERE log_type = 'datacheck' AND log_date IS NOT NULL AND log_date <> ''`,
        )
        .all() as Array<{ log_date: string }>;
      const realDates = dateRows
        .map((row) => row.log_date)
        .filter((d) => isRealCalendarDate(d) && d <= today)
        .sort();
      const logDate = realDates.length > 0 ? realDates[realDates.length - 1] : null;

      // ── ② 取该日全部 datacheck 行 → 按 checkId 去重 ────────────────
      //    `ORDER BY id DESC` + 「首次出现即采用」⇒ 每个 checkId 保留**最近一次**的结果
      //    （同一天重跑校验时，旧结果不能盖住新结果）。
      const rows = logDate
        ? (db
            .prepare(
              `SELECT check_item, level, message, detail FROM system_log
             WHERE log_type = 'datacheck' AND log_date = ?
             ORDER BY id DESC`,
            )
            .all(logDate) as Array<{
            check_item: string | null;
            level: string | null;
            message: string | null;
            detail: string | null;
          }>)
        : [];

      const byCheckId = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        const id = row.check_item ?? '';
        // 🔴 扩展校验（停牌/退市/ST/价差/成交量/滞后）**不占 C 编号**
        //   ⇒ 只认 `{C1..C12}`，其余（`C13+`、调度器写的汇总行、空 check_item）一律丢弃。
        if (!CHECK_IDS.includes(id)) continue;
        if (byCheckId.has(id)) continue;
        byCheckId.set(id, row);
      }

      // ── ③ 用 C1~C12 全集补齐（缺项 = SKIP + 「未运行」） ─────────────
      //    「12 条」的判定基准 = `{C1..C12}` 全集（裁决 D-1），
      //    **不是**「页面上恰好有 12 个 DOM 节点」这种可被空态蒙混的判据。
      //    ⚠️ 缺项**不得伪造 detail**（卡片里的 detail 留空 + message 写「未运行」）。
      const summaries = CHECK_IDS.map((checkId) => {
        const row = byCheckId.get(checkId);
        if (!row) {
          return {
            checkId,
            name: CHECK_NAMES[checkId],
            result: 'SKIP' as ResultState,
            message: '未运行',
            detail: null as string | null,
          };
        }
        return {
          checkId,
          name: CHECK_NAMES[checkId],
          result: toResultState(row.level),
          message: row.message ?? '',
          detail: row.detail ?? null,
        };
      });

      return reply.send(ok(summaries));
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // 行情最新几行
  app.get('/api/market/latest', async (request, reply) => {
    try {
      // 🔴 T60c：原为 `SELECT … FROM v_stock_qfq ORDER BY date DESC LIMIT 5`
      //   —— 为拿 5 行物化整个复权视图（2800 万行 × 4 JOIN）⇒ **实测 12.18s**。
      //   且本端点在 PUBLIC_ROUTES（免鉴权）⇒ 可被反复调用烧 CPU。
      //   现走基表 + MAX(date) + 显式前复权（口径逐条一致，见 marketData.ts 的注释）。
      const rows = await getLatestMarketSnapshot(5);
      return reply.send(ok(rows));
    } catch (err) {
      return reply
        .code(502)
        .send(fail(502, 'DB_UNAVAILABLE', 'DuckDB 不可用（需要先在服务器上执行 tdx2db init）'));
    }
  });
}
