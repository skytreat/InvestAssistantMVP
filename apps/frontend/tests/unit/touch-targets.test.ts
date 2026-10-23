import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T79 ② · Touch 友好尺寸
 *
 * jsdom 没有布局引擎，也不加载 `global.css` / 不实现 `pointer: coarse` 媒体查询，
 * 因此无法用 `getComputedStyle` 断言真实尺寸。这里退化为**静态断言**：
 * 只要 `@media (pointer: coarse)` 块存在，且块内声明了 44px 下限、
 * 覆盖了所有可点击控件选择器，即视为样式契约成立。
 *
 * 真正的触屏尺寸由浏览器/设备验证；本用例防的是「规则被误删/漏加」。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.resolve(here, '../../src/styles/global.css'), 'utf8');

/** 取出 `@media (pointer: coarse) { ... }` 的块内容（按花括号配对） */
function coarseBlock(): string {
  const start = css.search(/@media\s*\(pointer:\s*coarse\)\s*\{/);
  if (start < 0) throw new Error('global.css 缺少 @media (pointer: coarse)');
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('@media (pointer: coarse) 块未闭合');
}

describe('T79 ② · touch 友好尺寸（≥44px）', () => {
  it('存在粗指针媒体查询', () => {
    expect(css).toMatch(/@media\s*\(pointer:\s*coarse\)/);
  });

  it('可点击控件声明 44px 高度下限', () => {
    const block = coarseBlock();
    expect(block).toMatch(/min-height:\s*44px/);

    for (const selector of [
      'button',
      "[role='button']",
      'a',
      'input',
      'select',
      'textarea',
      'summary',
      'label',
    ]) {
      expect(block, `缺少选择器 ${selector}`).toContain(selector);
    }
  });

  it('按钮类控件声明 44px 宽度下限', () => {
    const block = coarseBlock();
    expect(block).toMatch(/min-width:\s*44px/);
  });

  it('触屏点击使用 touch-action: manipulation（去掉 300ms 延迟）', () => {
    const block = coarseBlock();
    expect(block).toMatch(/touch-action:\s*manipulation/);
  });
});
