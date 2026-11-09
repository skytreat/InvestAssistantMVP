import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import type { JwtPayload } from '../services/auth.js';
import { getTodaySignalStats } from '../services/todaySignals.js';
import {
  annotateSignalTradeStatus,
  collapseSignalsByCooldown,
  getSignalTradeLink,
  getTradeDate,
  resolveDefaultSignalTradeDate,
  resolveSignalCooldownBars,
} from '../services/signalService.js';
import type { CooldownRowFields, SignalLinkFields } from '../services/signalService.js';
import { ok, fail } from '../lib/envelope.js';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

/** F3：今日 Top 5 摘要的固定条数（PRD_v3 §4.2「今日 Top 5 摘要」） */
const TOP_SIGNALS_LIMIT = 5;

/**
 * 策略信号查询 API（T28 + T54）
 *
 * GET /api/signals
 *   ?trade_date=2026-10-15        单日过滤
 *   &start_date=2026-10-01       日期范围下界（含，>=）
 *   &end_date=2026-10-15          日期范围上界（含，<=）
 *   &asset_code=sh600000          单标的过滤
 *   &plugin_id=rsi_oversold
 *   &direction=buy
 *   &exclude_risk=1               排除风险类信号（sub_category='risk'；Top5 用）
 *   &page=1&page_size=20
 *
 * T54：所有筛选值一律走预编译参数化绑定（`?` 占位），禁止把入参拼进 SQL 文本；
 *      WHERE 子句按固定顺序 append，参数数组与占位符顺序严格一一对应。
 *      排序 `ORDER BY trade_date ASC`（T53/T54 要求升序），`created_at / id`
 *      作为同日同刻的确定性 tie-break，避免分页抖动。
 *
 * 🔴 **窗口口径（P2-2）**：分页窗口取**最近 N 条**（内层 DESC），
 *    输出再**升序**排回（外层 ASC）⇒ 页内升序不变，但第 1 页是**最新**的一页。
 *    与 K 线路由（`routes/kline.ts`）的「近 20 条信号」口径统一。
 */
export async function registerSignalRoutes(app: FastifyInstance) {
  app.get('/api/signal', async (request, reply) => {
    try {
      const user = (request as AuthedRequest).user;
      const q = request.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size ?? '20', 10)));

      const db = ConfigStore.getInstance().db;
      const where: string[] = ['user_id = ?', 'is_deleted = 0'];
      const params: Array<string | number> = [user.sub];

      /**
       * 🔴 **默认交易日口径（F 域 P0-1）**
       *
       * 修复前：前端硬编码 `trade_date=todayStr()` ⇒ 周末/节假日/行情未跑的日子进页**永远为空**，
       *   用户误以为「没有信号」。`/api/signal/stats` 更是在缺省时直接落到自然日今天。
       *
       * 修复后：调用方**完全没传日期条件**（`trade_date` / `start_date` / `end_date` 都没有）时，
       *   由 `resolveDefaultSignalTradeDate()` 解析口径（最近有信号日 → 最近行情日 → 今天），
       *   并随响应下发 `trade_date` / `trade_date_source` / `latest_quote_date`，**前端不再自己猜今天**。
       *
       * ⚠️ 这里**故意不注入 `trade_date` 过滤**：本接口的既有契约是
       *   「无筛选 = 最近 N 条（跨交易日窗口）」，与 K 线标记（`kline-signal-isolation`）
       *   共享同一行集合口径。默认口径只体现在响应元信息与前端展示上，不改变取数窗口。
       */
      const hasDateFilter = Boolean(q.trade_date || q.start_date || q.end_date);
      let effectiveTradeDate: string | null = q.trade_date ?? null;
      let dateSource: 'explicit' | 'signal' | 'quote' | 'today' = 'explicit';
      let latestQuoteDate: string | null = null;
      if (!hasDateFilter) {
        const resolved = await resolveDefaultSignalTradeDate(user.sub);
        effectiveTradeDate = resolved.tradeDate;
        dateSource = resolved.source;
        latestQuoteDate = resolved.latestQuoteDate;
      }

      if (q.asset_code) {
        where.push('asset_code = ?');
        params.push(q.asset_code);
      }
      if (q.trade_date) {
        where.push('trade_date = ?');
        params.push(q.trade_date);
      }
      // T54：日期范围闭区间 —— start_date 与 end_date 当天都算命中
      if (q.start_date) {
        where.push('trade_date >= ?');
        params.push(q.start_date);
      }
      if (q.end_date) {
        where.push('trade_date <= ?');
        params.push(q.end_date);
      }
      if (q.plugin_id) {
        where.push('plugin_id = ?');
        params.push(q.plugin_id);
      }
      if (q.direction) {
        where.push('direction = ?');
        params.push(q.direction);
      }
      /**
       * F1：分级筛选（PRD_v3 §4.2 顶部 tab：全部 / 强 / 中 / 弱 / 已过期）
       *
       * - `grade=strong|medium|weak` → 只看该档，并**排除已过期**（过期在「已过期」tab 单独展示）
       * - `grade=expired` → `expires_at < 今天`（未写过 expires_at 的历史行不算过期）
       * - 不传 → 保持既有「全部」语义（含过期），供 Dashboard / 其他调用方兼容
       */
      if (q.grade) {
        if (q.grade === 'expired') {
          where.push('(expires_at IS NOT NULL AND expires_at < ?)');
          params.push(getTradeDate());
        } else if (q.grade === 'strong' || q.grade === 'medium' || q.grade === 'weak') {
          where.push('grade = ?');
          params.push(q.grade);
          where.push('(expires_at IS NULL OR expires_at >= ?)');
          params.push(getTradeDate());
        } else {
          return reply
            .code(400)
            .send(fail(400, 'PARAM_INVALID', 'grade 只能是 strong / medium / weak / expired'));
        }
      }

      /**
       * F6：**展示层冷却合并去重**（`dedupe=1`）
       *
       * `dedupe` 缺省关闭 ⇒ 既有契约（原始行 + 分页计数）不变；
       * 前端 Signals 页显式传 `dedupe=1`，后端把「同策略+同标的+同方向、
       * 冷却窗口内重复」的信号合并成一条，并附 `consecutive_days`。
       *
       * ⚠️ 合并**只影响展示**：信号生成照旧一条不少，`cooldown_until` 只在这里读判窗口。
       * ⚠️ 合并必须在**分页前**做（否则 total 与页内条数对不上），
       *    故该路径一次性取全部过滤行再切页（MVP 信号量级可控）。
       */
      const dedupe = q.dedupe === '1' || q.dedupe === 'true';
      const requestedBars = parseInt(q.cooldown_bars ?? '', 10);
      const cooldownBars = Number.isFinite(requestedBars)
        ? Math.min(20, Math.max(1, requestedBars))
        : resolveSignalCooldownBars();

      /**
       * 🔴 风险类排除开关（Dashboard「今日最值得看的机会」Top5 专用）
       *
       * 判据用 `sub_category`（插件契约字段），**不用 plugin_id 字符串匹配** ——
       * 插件 id 可改名，子分类是稳定口径。`NULL` 视为非风险（历史行无子分类）。
       *
       * ⚠️ 默认**不排除**：信号页要按六分类展示全部信号（含风险提示），
       *    只有明确要看「交易机会」的场景（Top5）才传 `exclude_risk=1`。
       *    与 F1 `grade` / F6 `dedupe` **正交叠加**：先按子分类过滤，再分级/合并。
       */
      if (q.exclude_risk === '1' || q.exclude_risk === 'true') {
        where.push(`(sub_category IS NULL OR sub_category <> 'risk')`);
      }

      const whereSql = 'WHERE ' + where.join(' AND ');
      const count = (
        db.prepare(`SELECT COUNT(*) AS c FROM user_strategy_signal ${whereSql}`).get(...params) as {
          c: number;
        }
      ).c;
      /**
       * 🔴 **窗口口径 = 「最近 N 条，输出升序」**（P2-2 口径统一）
       *
       * 形状：内层 `ORDER BY trade_date DESC ... LIMIT ? OFFSET ?` 取**最近**一页，
       * 外层再 `ORDER BY trade_date ASC` 把这一页**升序**排回去。
       * ⇒ ① **每一页内部仍然是升序**（G5.5「signals 升序」不受影响）
       *   ② **第 1 页 = 最近 N 条**（此前 = 最早 N 条）
       *   ③ `created_at / id` 作确定性 tie-break ⇒ 同日同刻不抖动
       *
       * ⚠️ **为何改**：K 线路由（`routes/kline.ts`）下发的是该标的**最近 20 条**信号
       *   （图上标记画的就是最近的），而本端点此前给的是**最早 20 条** ⇒
       *   信号总数 >20 时，「图上标记」与「信号列表」**对不上**。
       *   统一为「最近 N 条 + 升序」后，两个端点**同一用户 + 同一标的 + 同一条数**
       *   返回**完全相同的行集合**。
       *
       * ⚠️ **对前端的影响**：`Signals.tsx` 默认筛「今日」+ 不重排 ⇒ 显示顺序不变；
       *   取消日期筛选后，第 1 页由「最早 20 条」变为「最近 20 条」（页内仍升序）；
       *   `Dashboard.tsx` 的「最新信号」卡片此前因本口径**显示的是最早的 5 条**（与卡片标题矛盾），
       *   改后与标题一致。
       */
      let rows: Array<SignalLinkFields & Record<string, unknown>>;
      let total = count;
      if (dedupe) {
        const all = db
          .prepare(
            `SELECT * FROM user_strategy_signal ${whereSql}
             ORDER BY trade_date ASC, created_at ASC, id ASC`,
          )
          .all(...params) as Array<CooldownRowFields & Record<string, unknown>>;
        const collapsed = collapseSignalsByCooldown(all, cooldownBars);
        total = collapsed.length;
        // 「最近 N 条 + 输出升序」：第 1 页仍是**最新**的一页（与未合并路径同口径）
        const end = Math.max(0, total - (page - 1) * pageSize);
        const start = Math.max(0, total - page * pageSize);
        rows = collapsed.slice(start, end);
      } else {
        rows = db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM user_strategy_signal ${whereSql}
               ORDER BY trade_date DESC, created_at DESC, id DESC
               LIMIT ? OFFSET ?
             )
             ORDER BY trade_date ASC, created_at ASC, id ASC`,
          )
          .all(...params, pageSize, (page - 1) * pageSize) as Array<
          SignalLinkFields & Record<string, unknown>
        >;
      }

      // F2：列表行补「已成交 / 已忽略 / 已采纳 / 未处理」派生状态（批量判定，不逐行查）
      const annotated = annotateSignalTradeStatus(rows, user.sub);

      reply.send(
        ok(annotated, {
          pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
          // F 域 P0-1：把「实际生效的交易日 + 来源 + 行情最新日」下发，前端不再自己猜今天
          trade_date: effectiveTradeDate,
          trade_date_source: dateSource,
          latest_quote_date: latestQuoteDate,
          // F6：展示层冷却合并的窗口根数（前端据此写旁注）
          cooldown_bars: cooldownBars,
          display_dedupe: dedupe,
        }),
      );
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  /**
   * GET /api/signal/stats —— **今日信号统计**（T67 Dashboard「今日动态概览卡 · 今日信号 ▲▼·」）
   *
   * ?trade_date=2026-10-20   指定交易日
   *   缺省（F 域 P0-1 修复后）= **最近有信号日** → **最近行情日** → 东八区今天，
   *   不再直接落到自然日今天（周末/节假日会误导成「今日 0 条」）。
   *
   * 响应：`{ total, up, down, hold }`（buy→up / sell→down / hold→hold）
   *
   * ── 为什么不复用 `GET /api/signal` 自己在前端数 ──
   *   `/api/signal` 是**分页**接口（`page_size` 上限 200）。信号条数超过 1 页时，
   *   前端拿到的只是第 1 页 → ▲▼· 计数会**静默偏小**（而 `pagination.total` 只是总数，
   *   拆不出方向分布）。本端点用 **1 次 GROUP BY** 在服务端算准，
   *   既不多一次往返，也不受分页影响。
   */
  app.get('/api/signal/stats', async (request, reply) => {
    try {
      const user = (request as AuthedRequest).user;
      const q = request.query as Record<string, string | undefined>;
      let tradeDate: string;
      let dateSource: 'explicit' | 'signal' | 'quote' | 'today' = 'explicit';
      let latestQuoteDate: string | null = null;
      if (q.trade_date) {
        tradeDate = q.trade_date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
          return reply.code(400).send(fail(400, 'PARAM_INVALID', 'trade_date 格式应为 YYYY-MM-DD'));
        }
      } else {
        const resolved = await resolveDefaultSignalTradeDate(user.sub);
        tradeDate = resolved.tradeDate;
        dateSource = resolved.source;
        latestQuoteDate = resolved.latestQuoteDate;
      }
      const stats = await getTodaySignalStats(user.sub, tradeDate);
      return reply.send(
        ok(stats, {
          trade_date: tradeDate,
          trade_date_source: dateSource,
          latest_quote_date: latestQuoteDate,
        }),
      );
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
  /**
   * GET /api/signal/top5 —— **今日 Top 5 摘要与优先级**（F3，PRD_v3 §4.2）
   *
   * ?trade_date=2026-11-06   指定交易日；缺省 = 最近有信号日 → 最近行情日 → 今天
   *
   * 与 `GET /api/signal` 的区别：
   *   - **强制单日**：只取一个交易日（默认日由后端解析），不跨交易日；
   *   - **按优先级排序**：`grade` 强 > 中 > 弱 > 未分级，同档 `strength` 降序
   *     （`strength` 为空排在同档末尾），最后按 `id` 倒序保证确定性；
   *   - 固定 `LIMIT 5`，供 Dashboard 摘要卡与 Signals 页摘要区共用。
   *
   * ⚠️ 未分级行（F1 尚未回填 `grade` 的存量数据）按 strength 排序，
   *    因此本端点**不依赖 F1 是否已落地**即可工作。
   *
   * 🔴 **风险类不参与 Top5**：本端点语义是「今日最值得看的机会」，
   *    风险提示（`sub_category='risk'`：单票占比 / 浮亏止损 / 集中度）挤进来会稀释它，
   *    故**默认排除**；`exclude_risk=0|false` 可显式放开（仅供排查/风险视角复用）。
   *    判据是子分类列，**不按 plugin_id 字符串匹配**；`NULL`（存量行）视为非风险。
   */
  app.get('/api/signal/top5', async (request, reply) => {
    try {
      const user = (request as AuthedRequest).user;
      const q = request.query as Record<string, string | undefined>;
      /**
       * 风险类排除开关：缺省 = **排除**（见上方契约），只有显式 `0/false` 才放开。
       * 与 `GET /api/signal` 的 `exclude_risk`（缺省 = 不排除）语义相反 ——
       * 因为该端点的定位是「机会」，而通用列表的定位是「全部信号（含风险提示）」。
       */
      const excludeRisk = q.exclude_risk === undefined || q.exclude_risk === '1' || q.exclude_risk === 'true';
      let tradeDate: string;
      let dateSource: 'explicit' | 'signal' | 'quote' | 'today' = 'explicit';
      let latestQuoteDate: string | null = null;
      if (q.trade_date) {
        tradeDate = q.trade_date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
          return reply.code(400).send(fail(400, 'PARAM_INVALID', 'trade_date 格式应为 YYYY-MM-DD'));
        }
      } else {
        const resolved = await resolveDefaultSignalTradeDate(user.sub);
        tradeDate = resolved.tradeDate;
        dateSource = resolved.source;
        latestQuoteDate = resolved.latestQuoteDate;
      }

      // 风险类排除条件（无用户输入，纯常量片段，不涉及拼接注入）
      const riskFilter = excludeRisk ? ` AND (sub_category IS NULL OR sub_category <> 'risk')` : '';
      const rows = ConfigStore.getInstance()
        .db.prepare(
          `SELECT * FROM user_strategy_signal
            WHERE user_id = ? AND is_deleted = 0 AND trade_date = ?${riskFilter}
            ORDER BY CASE grade
                       WHEN 'strong' THEN 0
                       WHEN 'medium' THEN 1
                       WHEN 'weak' THEN 2
                       ELSE 3
                     END,
                     strength IS NULL,
                     strength DESC,
                     id DESC
            LIMIT ?`,
        )
        .all(user.sub, tradeDate, TOP_SIGNALS_LIMIT);

      return reply.send(
        ok(rows, {
          trade_date: tradeDate,
          trade_date_source: dateSource,
          latest_quote_date: latestQuoteDate,
          limit: TOP_SIGNALS_LIMIT,
        }),
      );
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  /**
   * F4 Step C：采纳 / 忽略写路径（两个端点共用，行为严格对称）
   *
   * 口径：
   *   ① **服务端强制互斥** —— 设一个即把另一个清 0，且把对方的 `*_at` 置 NULL。
   *      选「静默覆盖」而不是「冲突返回 409」的理由：用户语义是「我现在怎么看这条信号」，
   *      二选一是正常操作而非错误；返 409 会逼前端再发一次反向请求，多一次写且要处理两个状态机。
   *   ② **幂等** —— 目标状态已成立（目标=1 且另一个=0）时**完全不写库**，
   *      返回 `unchanged: true`，因此 `*_at` 不会漂移。
   *   ③ `*_at` 用 `COALESCE(旧值, now)`：即使走到 UPDATE 分支，已有时间戳也不被覆盖。
   */
  const writeSignalFlag = (id: number, userId: number, flag: 'adopted' | 'ignored') => {
    const db = ConfigStore.getInstance().db;
    const other = flag === 'adopted' ? 'ignored' : 'adopted';
    const before = db
      .prepare(
        `SELECT adopted, ignored FROM user_strategy_signal
          WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      )
      .get(id, userId) as { adopted: number; ignored: number } | undefined;
    if (!before) return null;

    const unchanged = before[flag] === 1 && before[other] === 0;
    if (!unchanged) {
      // 列名来自上面的字面量联合类型，不含外部输入
      db.prepare(
        `UPDATE user_strategy_signal
            SET ${flag} = 1,
                ${flag}_at = COALESCE(${flag}_at, datetime('now','localtime')),
                ${other} = 0,
                ${other}_at = NULL
          WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      ).run(id, userId);
    }

    const after = db
      .prepare(`SELECT adopted, ignored, adopted_at, ignored_at FROM user_strategy_signal WHERE id = ?`)
      .get(id) as {
      adopted: number;
      ignored: number;
      adopted_at: string | null;
      ignored_at: string | null;
    };
    return {
      id,
      adopted: after.adopted,
      ignored: after.ignored,
      adoptedAt: after.adopted_at,
      ignoredAt: after.ignored_at,
      unchanged,
    };
  };

  // T134（V3.4）信号采纳/忽略标注；F4 Step C 补互斥与幂等
  app.patch('/api/signal/:id/adopt', async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send(fail(400, 'INVALID_ID', 'id 非法'));
    const result = writeSignalFlag(id, user.sub, 'adopted');
    if (!result) return reply.code(404).send(fail(404, 'NOT_FOUND', '信号不存在'));
    return reply.send(ok(result));
  });

  app.patch('/api/signal/:id/ignore', async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send(fail(400, 'INVALID_ID', 'id 非法'));
    const result = writeSignalFlag(id, user.sub, 'ignored');
    if (!result) return reply.code(404).send(fail(404, 'NOT_FOUND', '信号不存在'));
    return reply.send(ok(result));
  });
  // T141（V3.7）信号↔交易手动关联（INV-S3-15/16、INV-S6-4）
  /**
   * F2 幂等与冲突约定（本路由钉死，PR 说明同步）：
   *
   *   ① 重复关联**同一条**成交 → 200 + `unchanged: true`，不重复写、不报错
   *   ② 信号已指向**另一条**成交 → 409 `SIGNAL_ALREADY_LINKED`；
   *      确需改指向时显式传 `overwrite: true`（前端二次确认后才发）
   *   ③ **一条成交可被多条信号关联**（成交是事实，信号是判断）；
   *      响应附 `shared_signals`（除本条信号外，还有几条信号指向该成交）
   *   ④ `tradeRecordId: null` → 解绑（幂等：已解绑再解绑仍 200）
   *
   * 关联方向：`user_strategy_signal.linked_trade_id → user_trade_record.id`
   */
  app.patch('/api/signal/:id/link-trade', async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send(fail(400, 'INVALID_ID', 'id 非法'));
    const body = (request.body ?? {}) as { tradeRecordId?: number | null; overwrite?: boolean };
    const tradeId = body.tradeRecordId == null ? null : Number(body.tradeRecordId);
    if (tradeId != null && (!Number.isFinite(tradeId) || tradeId <= 0)) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', 'tradeRecordId 非法'));
    }
    const db = ConfigStore.getInstance().db;
    const sig = db
      .prepare(
        `SELECT id, asset_code, linked_trade_id FROM user_strategy_signal
         WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      )
      .get(id, user.sub) as { id: number; asset_code: string; linked_trade_id: number | null } | undefined;
    if (!sig) return reply.code(404).send(fail(404, 'NOT_FOUND', '信号不存在'));

    // 解绑路径
    if (tradeId == null) {
      if (sig.linked_trade_id == null) {
        return reply.send(ok({ id, linked_trade_id: null, unchanged: true, shared_signals: 0 }));
      }
      db.prepare('UPDATE user_strategy_signal SET linked_trade_id = NULL WHERE id = ? AND user_id = ?').run(
        id,
        user.sub,
      );
      return reply.send(ok({ id, linked_trade_id: null, unchanged: false, shared_signals: 0 }));
    }

    const rec = db
      .prepare('SELECT id, asset_code FROM user_trade_record WHERE id = ? AND user_id = ? AND is_deleted = 0')
      .get(tradeId, user.sub) as { id: number; asset_code: string } | undefined;
    if (!rec) return reply.code(404).send(fail(404, 'NOT_FOUND', '交易记录不存在'));
    if (rec.asset_code !== sig.asset_code) {
      return reply.code(400).send(fail(400, 'ASSET_MISMATCH', '信号与交易标的不一致'));
    }

    // 该成交已被多少条**其他**信号指向（多对一允许，但要如实告知）
    const shared = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM user_strategy_signal
           WHERE user_id = ? AND linked_trade_id = ? AND is_deleted = 0 AND id <> ?`,
        )
        .get(user.sub, tradeId, id) as { c: number }
    ).c;

    // 幂等：已指向同一条成交
    if (sig.linked_trade_id === tradeId) {
      return reply.send(ok({ id, linked_trade_id: tradeId, unchanged: true, shared_signals: shared }));
    }
    // 冲突：已指向另一条成交，未显式授权改指向
    if (sig.linked_trade_id != null && !body.overwrite) {
      return reply
        .code(409)
        .send(
          fail(
            409,
            'SIGNAL_ALREADY_LINKED',
            `该信号已关联成交 #${sig.linked_trade_id}，如需改指向请确认后重试（overwrite: true）`,
          ),
        );
    }

    db.prepare('UPDATE user_strategy_signal SET linked_trade_id = ? WHERE id = ? AND user_id = ?').run(
      tradeId,
      id,
      user.sub,
    );
    return reply.send(ok({ id, linked_trade_id: tradeId, unchanged: false, shared_signals: shared }));
  });

  /**
   * F2 —— 按信号查其关联成交（读取侧）
   *
   * GET /api/signal/:id/linked-trade
   * 响应：`{ signal_id, asset_code, trade_date, direction, linked_trade_id,
   *          trade_status, link_broken, trade }`
   * `trade` 为 null 时：未关联，**或**关联的成交已被软删（此时 `link_broken: true`）。
   */
  app.get('/api/signal/:id/linked-trade', async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send(fail(400, 'INVALID_ID', 'id 非法'));
    const view = getSignalTradeLink(user.sub, id);
    if (!view) return reply.code(404).send(fail(404, 'NOT_FOUND', '信号不存在'));
    return reply.send(ok(view));
  });
}
