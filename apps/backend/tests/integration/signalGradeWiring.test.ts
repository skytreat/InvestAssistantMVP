/**
 * T156 —— admin 手动触发信号生成路径的**定级接线**回归测试
 *
 * 🔴 事故背景（2026-11-14 arm 生产实测）：信号页两 Tab 全空 ⇒ 根因是
 *    `assignSignalGrades` / `assignSignalCooldowns` **只被回放链路调用**，
 *    17:02 实时链路与 admin 手动触发**都没调** ⇒ `grade` 恒为 NULL
 *    ⇒ 前端分级默认档（强）把全部行滤掉。
 *
 * 本文件走**真实 HTTP 路径**（`app.inject()` → `POST /api/admin/run-signal`）
 * 断言：手动触发后当日已落库信号拿到 `grade` / `expires_at` / `cooldown_until`。
 *
 * （17:02 cron 段的同类断言见 `tests/unit/signalGradeWiring.test.ts`）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupIntegrationTest, type TestAppBundle } from './_helpers.js';

/** 固定交易日（周五）—— 纯工作日兜底下 +1=周一 / +2=周二 / +3=周三 */
const TRADE_DATE = '2026-11-13';

let bundle: TestAppBundle;

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${bundle.adminToken}`, 'content-type': 'application/json' };
}

function insertSignal(code: string, strength: number | null): number {
  return Number(
    bundle.db.db
      .prepare(
        `INSERT INTO user_strategy_signal
           (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label,
            strength, grade, expires_at, metrics_json, is_final, origin)
         VALUES (?, ?, 'macd_cross', 'monitor', ?, 'buy', 'L', ?, NULL, NULL, '{}', 1, 'live')`,
      )
      .run(bundle.userId, code, TRADE_DATE, strength).lastInsertRowid,
  );
}

function readGrade(id: number): {
  grade: string | null;
  expires_at: string | null;
  cooldown_until: string | null;
} {
  return bundle.db.db
    .prepare(`SELECT grade, expires_at, cooldown_until FROM user_strategy_signal WHERE id = ?`)
    .get(id) as { grade: string | null; expires_at: string | null; cooldown_until: string | null };
}

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
});

describe('T156 · admin 手动触发信号生成 → 必须定级 + 标冷却', () => {
  it('触发后当日信号拿到 grade / expires_at / cooldown_until', async () => {
    const id = insertSignal('sh600000', 0.9);
    expect(readGrade(id).grade).toBeNull();

    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/run-signal',
      headers: adminHeaders(),
      payload: { trade_date: TRADE_DATE },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);

    const after = readGrade(id);
    // ① 定级（单候选 ⇒ 绝对分值兜底：0.9 ≥ 0.6 ⇒ strong）
    expect(after.grade).toBe('strong');
    // ② 有效期
    expect(after.expires_at).toBeTruthy();
    // ③ 冷却窗口
    expect(after.cooldown_until).toBeTruthy();
    // ④ 响应体带上定级结果（运维可观测）
    expect(body.data.graded).toBeDefined();
    expect(typeof body.data.graded.graded).toBe('number');
    expect(body.data.cooldown_until).toBeTruthy();
  }, 60000);

  it('监控类信号（strength IS NULL）保持未分级，但拿到冷却窗口', async () => {
    const id = insertSignal('sh600001', null);

    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/run-signal',
      headers: adminHeaders(),
      payload: { trade_date: TRADE_DATE },
    });
    expect(res.statusCode).toBe(200);

    const after = readGrade(id);
    expect(after.grade).toBeNull();
    expect(after.expires_at).toBeNull();
    expect(after.cooldown_until).toBeTruthy();
  }, 60000);
});
