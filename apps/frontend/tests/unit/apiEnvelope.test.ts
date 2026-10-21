/**
 * T89b —— 前端统一 envelope 判定（`api/envelope.ts`）
 *
 * 覆盖两件事：
 *
 * 1. **判定函数的语义** —— `isOkEnvelope` / `isFailedEnvelope` 的边界行为
 *    （它们是 T89b 之前 `success === true` / `success === false` 的**逐字等价物**）；
 * 2. **源码守卫** —— `apps/frontend/src` 里**不得再有**响应判定类的 `.success` 读取
 *    （即 T89b 的验收点 ①：`grep -rn '\.success' apps/frontend/src` 中响应判定类归零）。
 *
 * ⚠️ **源码守卫为什么必要**：前端 20+ 处判定散在 9 个 page + 8 个 component 里，
 *   没有任何类型系统能保证「没人又写回 `res.data.success`」。
 *   后端已删 `success` 字段 ⇒ 那种写法会**静默恒为 falsy** ⇒ 页面空白但**不报错**。
 *   ⇒ 用一条测试把它钉死。
 *
 * ⚠️ **守卫的白名单**：`.success` 还有**与响应无关**的同名字段（不是 envelope 字段），
 *   不得误伤：
 *   - `COLORS.success` —— 颜色 token（盈利绿）
 *   - `successStyle` / `textSuccess` —— 样式
 *   - `stats.success` —— **插件批量执行统计**（`{total, success, timeout, error}`）
 *   - `result.sqlite?.success` / `result.duckdb?.success` —— **备份服务自己的结果字段**
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOkEnvelope, isFailedEnvelope } from '../../src/api/envelope';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../../src');

/** 收集 src 下所有 .ts / .tsx 源文件 */
function collectSources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push({ file: path.relative(SRC_DIR, full), text: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('T89b · `isOkEnvelope`（成功判定唯一口径 = `code === 0`）', () => {
  it('`code === 0`（数字）⇒ 成功', () => {
    expect(isOkEnvelope({ code: 0 })).toBe(true);
    expect(isOkEnvelope({ code: 0, data: [], timestamp: '2026-10-21T00:00:00.000Z' })).toBe(true);
  });

  it('`code` 是非 0 ⇒ 失败', () => {
    expect(isOkEnvelope({ code: 1 })).toBe(false);
    expect(isOkEnvelope({ code: 'PARAM_INVALID' })).toBe(false);
    expect(isOkEnvelope({ code: 'HOLDING_INSUFFICIENT' })).toBe(false);
  });

  it('缺 `code` / 非对象 ⇒ 失败（契约：成功必带 `code: 0`）', () => {
    expect(isOkEnvelope({})).toBe(false);
    expect(isOkEnvelope({ data: [] })).toBe(false);
    expect(isOkEnvelope(null)).toBe(false);
    expect(isOkEnvelope(undefined)).toBe(false);
    expect(isOkEnvelope('')).toBe(false);
    expect(isOkEnvelope(0)).toBe(false);
  });

  it('`code` 是字符串 `"0"` ⇒ 失败（后端发的是**数字** 0；字符串是错误码的位置）', () => {
    expect(isOkEnvelope({ code: '0' })).toBe(false);
  });
});

describe('T89b · `isFailedEnvelope`（**显式**失败 = `code` 存在且 ≠ 0）', () => {
  it('`code` 非 0 ⇒ 失败', () => {
    expect(isFailedEnvelope({ code: 'PARAM_INVALID' })).toBe(true);
    expect(isFailedEnvelope({ code: 1 })).toBe(true);
  });

  it('`code === 0` / 缺 `code` ⇒ **不**算失败（与旧 `success === false` 逐字等价）', () => {
    expect(isFailedEnvelope({ code: 0 })).toBe(false);
    expect(isFailedEnvelope({})).toBe(false);
    expect(isFailedEnvelope({ code: null })).toBe(false);
    expect(isFailedEnvelope(null)).toBe(false);
    expect(isFailedEnvelope(undefined)).toBe(false);
  });
});

describe('T89b · 源码守卫（前端不得再读响应体的 `success`）', () => {
  it('`apps/frontend/src` 内没有响应判定类的 `.success` 读取', () => {
    // ① 响应体上的 `.data.success` / `.data?.success`
    const dataPattern = /\.data\??\.success\b/;
    // ② 响应体变量上的 `body.success` / `body?.success`
    const bodyPattern = /\bbody\??\.success\b/;

    const hits: string[] = [];
    for (const { file, text } of collectSources(SRC_DIR)) {
      // 注释里的历史说明不算违规（只查代码行：剔除行注释与块注释）
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (dataPattern.test(code) || bodyPattern.test(code)) hits.push(file);
    }
    expect(
      hits.sort(),
      `以下文件仍在读响应体的 \`success\`（后端已删该字段 ⇒ 判定会恒为 falsy）：\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('同名字段（非响应判定）**仍然保留**（守卫不能误伤）', () => {
    const all = collectSources(SRC_DIR)
      .map(({ text }) => text)
      .join('\n');
    // 颜色 token（盈利绿）
    expect(all).toContain('COLORS.success');
    // 插件批量执行统计（嵌套业务对象）
    expect(all).toMatch(/stats\.success/);
    // 备份服务自己的结果字段（嵌套业务对象）
    expect(all).toMatch(/sqlite\?\.success/);
    expect(all).toMatch(/duckdb\?\.success/);
  });
});
