/**
 * jsdom 的 Canvas 2D context 替身（K 线图测试基建）
 *
 * ## 为什么需要
 *
 * jsdom **未实现** `HTMLCanvasElement.prototype.getContext('2d')`（返回 `null`），
 * 而 `klinecharts@10.1.0` 在创建图表时会立刻 `ctx.scale(...)` →
 * **抛 `Cannot read properties of null (reading 'scale')`** → 图表根本建不起来。
 *
 * ⚠️ 但**装了替身之后，klinecharts 在 jsdom 里可以完整跑通**（实测）：
 * 建图 → `setDataLoader` 灌数 → `createIndicator` → `getIndicators()[].result`
 * 读回灌入的值 —— 于是「注册的自定义指标读回的 result 与前端算出的值逐位相同」
 * 这条断言**可以在单测里真跑**，不必只靠真浏览器。
 *
 * ## 替身做了什么
 *
 * - 所有绘图方法（`save` / `fillRect` / `lineTo` / `fillText` …）→ **空实现**
 * - `measureText` → 返回**估算宽度**（图表用它算 y 轴标签宽度）
 * - `createLinearGradient` / `createRadialGradient` → 返回带 `addColorStop` 的空对象
 * - 未知属性 → 返回空函数（`Proxy` 兜底，避免图表调用到未实现的方法时炸掉）
 *
 * ⚠️ **视觉断言（y 轴范围、十字光标位置）仍必须在真浏览器验** ——
 *    替身不产出任何像素，只保证「逻辑链路可跑」。
 */

/** 被替身覆盖的原始方法（用于还原）*/
let originalGetContext: unknown = null;
let originalToDataURL: unknown = null;

/** 造一个「什么都不画」的 2D context */
export function createFakeContext2D(canvas?: HTMLCanvasElement): CanvasRenderingContext2D {
  const noop = () => undefined;
  const target: Record<string, unknown> = {
    canvas: canvas ?? null,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    shadowBlur: 0,
    shadowColor: 'transparent',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    direction: 'inherit',
    filter: 'none',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    measureText: (text: string) => ({
      width: text.length * 6,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 6,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
    }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    isPointInPath: () => false,
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };

  const methods = [
    'save',
    'restore',
    'scale',
    'rotate',
    'translate',
    'transform',
    'setTransform',
    'resetTransform',
    'clearRect',
    'fillRect',
    'strokeRect',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'bezierCurveTo',
    'quadraticCurveTo',
    'arc',
    'arcTo',
    'ellipse',
    'rect',
    'fill',
    'stroke',
    'clip',
    'setLineDash',
    'fillText',
    'strokeText',
    'drawImage',
    'putImageData',
  ];
  for (const name of methods) target[name] = noop;

  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      return noop;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** 安装替身（幂等）*/
export function installFakeCanvas(): void {
  if (typeof HTMLCanvasElement === 'undefined') return;
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  if (originalGetContext === null) {
    originalGetContext = proto.getContext;
    originalToDataURL = proto.toDataURL;
  }
  proto.getContext = function getContext(this: HTMLCanvasElement) {
    return createFakeContext2D(this);
  };
  proto.toDataURL = () => 'data:image/png;base64,';
}

/** 还原替身 */
export function restoreFakeCanvas(): void {
  if (typeof HTMLCanvasElement === 'undefined') return;
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  if (originalGetContext !== null) proto.getContext = originalGetContext;
  if (originalToDataURL !== null) proto.toDataURL = originalToDataURL;
  originalGetContext = null;
  originalToDataURL = null;
}
