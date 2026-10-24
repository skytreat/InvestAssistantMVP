/**
 * pluginEnabledFlag.test.ts —— `normalizeEnabledFlag` 纯函数单测
 *
 * 🔴 **本波修复的缺陷 ②**：better-sqlite3 **不能绑定 boolean**
 *   （只能绑 number / string / bigint / Buffer / null）⇒ 请求体传 `{ enabled: true }`
 *   会让 `UPDATE user_plugin_config SET enabled = ?` 抛 `TypeError`。
 *   路由若无 try/catch ⇒ **500 + Fastify 默认错误体**（缺 `code` / `timestamp`），
 *   违反 SDD §4.2 的统一 envelope。
 *
 * ⇒ 后端必须在**参数层**把 `enabled` 收口成 `0` / `1`，
 *   认不出来的取值回 **400 `PARAM_INVALID`**（而不是 500）。
 */
import { describe, it, expect } from 'vitest';
import { normalizeEnabledFlag } from '../../src/routes/plugin.js';

describe('normalizeEnabledFlag —— enabled 收口成 SQLite 可绑定的 0/1', () => {
  it('布尔值：true → 1，false → 0', () => {
    expect(normalizeEnabledFlag(true)).toBe(1);
    expect(normalizeEnabledFlag(false)).toBe(0);
  });

  it('数字：1 → 1，0 → 0', () => {
    expect(normalizeEnabledFlag(1)).toBe(1);
    expect(normalizeEnabledFlag(0)).toBe(0);
  });

  it("字符串：'1'/'true' → 1，'0'/'false' → 0（大小写与空格不敏感）", () => {
    expect(normalizeEnabledFlag('1')).toBe(1);
    expect(normalizeEnabledFlag('0')).toBe(0);
    expect(normalizeEnabledFlag('true')).toBe(1);
    expect(normalizeEnabledFlag('false')).toBe(0);
    expect(normalizeEnabledFlag('TRUE')).toBe(1);
    expect(normalizeEnabledFlag(' false ')).toBe(0);
  });

  it('非法取值一律返回 null（由路由回 400 PARAM_INVALID）', () => {
    for (const bad of [2, -1, 0.5, 'yes', 'no', '', '2', null, undefined, {}, [], NaN]) {
      expect(normalizeEnabledFlag(bad), `${JSON.stringify(bad)} 不该被接受`).toBeNull();
    }
  });
});
