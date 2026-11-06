/**
 * adminRole.test.ts — UX-08 · 管理员角色**原子转移**集成测试
 *
 * ## 覆盖的验收标准（审计原文 UX-08）
 *
 * | 验收标准 | 用例 |
 * |---|---|
 * | 当前唯一 admin 可以把管理员转移给另一个用户 | 转移成功 → 目标为唯一 admin，自己变为普通用户 |
 * | 转移后当前账号为普通用户、目标成为唯一管理员 | 同上 |
 * | 任一步失败时事务回滚，不出现 0 个 / 2 个 admin | 事务中途失败 → 整体回滚（临时 TRIGGER 让第二步抛错）|
 * | 审计日志 / 权限 | 转移写入 system_log；降级自己仍 400 |
 *
 * ## 如何证明「回滚」
 *
 * 用一条临时 SQLite TRIGGER 让事务体的**第二步**（把目标升为 admin）`RAISE(ABORT)`：
 * 第一步「把自己降为 user」已经执行，若没有事务包裹，库里就会停在「0 个 admin」状态。
 * 断言两边角色**都不变** + admin 数仍为 1 ⇒ 证明整体 ROLLBACK。
 *
 * ⚠️ 本文件与其它集成测试共享 `_helpers.ts` 的临时库 ⇒ 用例结束后必须把
 *    `int_admin` 恢复成 admin，避免后续文件的 admin 端点全部 403。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestApp, ADMIN_USER } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';
import { signToken } from '../../src/services/auth.js';

let bundle: TestAppBundle;
/** 当前唯一 admin（操作者）*/
let operatorId = 0;
/** 回滚用例的靶子（保持普通用户）*/
let targetAId = 0;
/** 成功转移用例的靶子 */
let targetBId = 0;
let targetBName = '';

const ROLLBACK_TRIGGER = 'ux08_block_promotion';

function db(): TestAppBundle['db']['db'] {
  return bundle.db.db;
}

function roleOf(userId: number): string {
  return (db().prepare('SELECT role FROM user_account WHERE id = ?').get(userId) as { role: string }).role;
}

function adminCount(): number {
  return (
    db().prepare(`SELECT COUNT(*) AS cnt FROM user_account WHERE role = 'admin'`).get() as {
      cnt: number;
    }
  ).cnt;
}

/** 发一次角色变更请求（默认用 admin token）*/
function patchRole(userId: number, role: 'user' | 'admin', token = bundle.adminToken) {
  return bundle.app.inject({
    method: 'PATCH',
    url: `/api/admin/role/${userId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { role },
  });
}

beforeAll(async () => {
  bundle = await createTestApp();
  operatorId = bundle.userId;

  const adminHash = (
    db().prepare('SELECT password_hash FROM user_account WHERE username = ?').get(ADMIN_USER) as {
      password_hash: string;
    }
  ).password_hash;
  const insertUser = (name: string): void => {
    db()
      .prepare('INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
      .run(name, adminHash, 'user');
  };
  insertUser('ux08_target_a');
  insertUser('ux08_target_b');
  targetAId = (
    db().prepare('SELECT id FROM user_account WHERE username = ?').get('ux08_target_a') as { id: number }
  ).id;
  targetBId = (
    db().prepare('SELECT id FROM user_account WHERE username = ?').get('ux08_target_b') as { id: number }
  ).id;
  targetBName = 'ux08_target_b';
});

/**
 * 每个用例都从「操作者是唯一 admin、两个靶子都是普通用户」的基线出发
 *
 * ⚠️ `vitest.config.ts` 开了 `sequence.shuffle` —— **用例顺序会被打乱**，
 *    用例之间不能有隐式顺序依赖（否则单独跑过、组合跑随机红）。
 */
beforeEach(() => {
  db().exec(`DROP TRIGGER IF EXISTS ${ROLLBACK_TRIGGER}`);
  db().prepare(`UPDATE user_account SET role = 'user' WHERE id IN (?, ?)`).run(targetAId, targetBId);
  db().prepare(`UPDATE user_account SET role = 'admin' WHERE id = ?`).run(operatorId);
});

afterAll(async () => {
  db().exec(`DROP TRIGGER IF EXISTS ${ROLLBACK_TRIGGER}`);
  // 夹具复位：无论用例成功与否，都让共享库回到「int_admin 是唯一 admin」
  db().prepare(`UPDATE user_account SET role = 'user' WHERE id IN (?, ?)`).run(targetAId, targetBId);
  db().prepare(`UPDATE user_account SET role = 'admin' WHERE id = ?`).run(operatorId);
  await bundle.app.close().catch(() => {});
});

describe('UX-08 · 管理员角色原子转移', () => {
  it('事务中途失败 → 整体回滚：两边角色不变，admin 数仍为 1', async () => {
    // 让「升目标为 admin」这一步在事务内抛错（前一步「降自己」已经执行过）
    db().exec(
      `CREATE TRIGGER ${ROLLBACK_TRIGGER} BEFORE UPDATE OF role ON user_account
       WHEN NEW.role = 'admin' AND OLD.role <> 'admin'
       BEGIN SELECT RAISE(ABORT, 'UX-08 模拟事务第二步失败'); END;`,
    );
    try {
      const res = await patchRole(targetAId, 'admin');
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).code).toBe('INTERNAL_ERROR');
    } finally {
      db().exec(`DROP TRIGGER IF EXISTS ${ROLLBACK_TRIGGER}`);
    }

    // 回滚证明：操作者仍是 admin，目标仍是 user，全库 admin 数仍为 1
    expect(roleOf(operatorId)).toBe('admin');
    expect(roleOf(targetAId)).toBe('user');
    expect(adminCount()).toBe(1);
  });

  it('转移成功 → 目标为唯一 admin，自己变为普通用户（写审计日志）', async () => {
    const res = await patchRole(targetBId, 'admin');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);

    expect(roleOf(targetBId)).toBe('admin');
    expect(roleOf(operatorId)).toBe('user');
    expect(adminCount()).toBe(1);

    const log = db()
      .prepare(`SELECT message FROM system_log WHERE message LIKE '%管理员转移给%' ORDER BY id DESC LIMIT 1`)
      .get() as { message: string } | undefined;
    expect(log?.message).toContain('管理员转移给');
  });

  it('新 admin 可把管理员再转移回原账号（双向一致）', async () => {
    // 先转出去（用例顺序会被 shuffle，不能依赖上一个用例留下的状态）
    const first = await patchRole(targetBId, 'admin');
    expect(first.statusCode).toBe(200);

    const newAdminToken = signToken({ sub: targetBId, username: targetBName, role: 'admin' });
    const res = await patchRole(operatorId, 'admin', newAdminToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);

    expect(roleOf(operatorId)).toBe('admin');
    expect(roleOf(targetBId)).toBe('user');
    expect(adminCount()).toBe(1);
  });

  it('降级自己 → 400（引导改用「转移管理员」，不制造 0 个 admin）', async () => {
    const res = await patchRole(operatorId, 'user');
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('PARAM_INVALID');
    expect(String(body.message)).toContain('转移管理员');
    expect(roleOf(operatorId)).toBe('admin');
    expect(adminCount()).toBe(1);
  });
});
