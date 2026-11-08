/**
 * 复刻 Python 的 `format(v, '.17g')`（DAS-2 §6.1「float64 全精度」）。
 *
 * 不能直接用 JS 的 `toPrecision(17)`：
 * 1. 它保留尾随 0（`1.5` → `1.5000000000000000`），而 `%g` 会去掉；
 * 2. 指数切换阈值不同（JS 在 `exp < -6` 才用科学计数法，`%g` 是 `exp < -4`）；
 * 3. 指数位宽不同（Python `e-05`，JS `e-5`）。
 */
export function formatG17(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`不能把非有限值序列化为 .17g：${String(value)}`);
  }
  if (value === 0) return '0';

  const negative = value < 0;
  const abs = Math.abs(value);
  // 17 位有效数字：1 位整数 + 16 位小数
  const [mantissa, exponentText] = abs.toExponential(16).split('e');
  const exponent = Number.parseInt(exponentText, 10);
  const digits = mantissa.replace('.', '');

  // %g：指数 < -4 或 >= 精度(17) 时用科学计数法
  if (exponent < -4 || exponent >= 17) {
    let mantissaTrimmed = stripTrailingZeros(mantissa);
    if (mantissaTrimmed.endsWith('.')) mantissaTrimmed = mantissaTrimmed.slice(0, -1);
    const sign = exponent < 0 ? '-' : '+';
    const absExp = String(Math.abs(exponent)).padStart(2, '0');
    return `${negative ? '-' : ''}${mantissaTrimmed}e${sign}${absExp}`;
  }

  let fixedText: string;
  if (exponent >= 0) {
    const integerPart = digits.slice(0, exponent + 1);
    const fractionPart = digits.slice(exponent + 1);
    fixedText = fractionPart.length > 0 ? `${integerPart}.${fractionPart}` : integerPart;
  } else {
    fixedText = `0.${'0'.repeat(-exponent - 1)}${digits}`;
  }
  fixedText = stripTrailingZeros(fixedText);
  if (fixedText.endsWith('.')) fixedText = fixedText.slice(0, -1);
  return negative ? `-${fixedText}` : fixedText;
}

function stripTrailingZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '');
}
