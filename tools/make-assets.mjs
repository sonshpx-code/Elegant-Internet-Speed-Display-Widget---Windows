/**
 * 生成 hud-app/assets 下的图标（托盘图标与应用图标）。
 *
 * 为什么自己写 PNG：这个工程的原则是不引入任何依赖，而图标必须是真的 PNG 文件
 * （Electron 的 nativeImage 不会栅格化 SVG）。Node 内置了 zlib，所以一个
 * CRC32 + IDAT 的小编码器就够了，不需要 sharp/canvas 这类原生模块。
 *
 * 画法：4 倍超采样后做盒式降采样，边缘就不会有锯齿。
 *
 *   node tools/make-assets.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'hud-app', 'assets');

/* --------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** rgba: Uint8Array(width*height*4) */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;                                     // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- 画布 */

const SS = 4;   // 超采样倍数

class Canvas {
  constructor(width, height) {
    this.w = width * SS;
    this.h = height * SS;
    this.px = new Uint8Array(this.w * this.h * 4);
  }

  blend(x, y, [r, g, b], a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const dst = this.px;
    const sa = Math.min(1, a);
    const da = dst[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    dst[i] = Math.round((r * sa + dst[i] * da * (1 - sa)) / outA);
    dst[i + 1] = Math.round((g * sa + dst[i + 1] * da * (1 - sa)) / outA);
    dst[i + 2] = Math.round((b * sa + dst[i + 2] * da * (1 - sa)) / outA);
    dst[i + 3] = Math.round(outA * 255);
  }

  /** 圆角矩形；color 为 [r,g,b]，alpha 为 0..1 */
  roundRect(x, y, w, h, radius, color, alpha = 1) {
    const X = x * SS, Y = y * SS, W = w * SS, H = h * SS, R = radius * SS;
    for (let py = Math.floor(Y); py < Math.ceil(Y + H); py += 1) {
      for (let px = Math.floor(X); px < Math.ceil(X + W); px += 1) {
        const cx = Math.min(Math.max(px + 0.5, X + R), X + W - R);
        const cy = Math.min(Math.max(py + 0.5, Y + R), Y + H - R);
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy > R * R) continue;
        this.blend(px, py, color, alpha);
      }
    }
  }

  /** 带圆头的粗线段（画箭头用） */
  line(x1, y1, x2, y2, width, color, alpha = 1) {
    const X1 = x1 * SS, Y1 = y1 * SS, X2 = x2 * SS, Y2 = y2 * SS, W = (width * SS) / 2;
    const minX = Math.floor(Math.min(X1, X2) - W - 1);
    const maxX = Math.ceil(Math.max(X1, X2) + W + 1);
    const minY = Math.floor(Math.min(Y1, Y2) - W - 1);
    const maxY = Math.ceil(Math.max(Y1, Y2) + W + 1);
    const vx = X2 - X1, vy = Y2 - Y1;
    const len2 = vx * vx + vy * vy || 1;
    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const t = Math.min(1, Math.max(0, ((px + 0.5 - X1) * vx + (py + 0.5 - Y1) * vy) / len2));
        const dx = px + 0.5 - (X1 + t * vx);
        const dy = py + 0.5 - (Y1 + t * vy);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > W) continue;
        this.blend(px, py, color, alpha * Math.min(1, (W - dist) / 1.2));
      }
    }
  }

  /** 盒式降采样到目标尺寸 */
  resolve(width, height) {
    const out = new Uint8Array(width * height * 4);
    const n = SS * SS;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy += 1) {
          for (let sx = 0; sx < SS; sx += 1) {
            const i = ((y * SS + sy) * this.w + (x * SS + sx)) * 4;
            const alpha = this.px[i + 3] / 255;
            r += this.px[i] * alpha;
            g += this.px[i + 1] * alpha;
            b += this.px[i + 2] * alpha;
            a += alpha;
          }
        }
        const o = (y * width + x) * 4;
        if (a <= 0) continue;
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
    return out;
  }
}

/* --------------------------------------------------------------- 图形 */

const DOWN = [52, 211, 153];
const UP = [96, 165, 250];

/** 下行箭头（实心带箭头），画在给定的竖直区间里 */
function drawArrow(canvas, cx, top, bottom, color, thickness) {
  const head = (bottom - top) * 0.34;
  canvas.line(cx, top, cx, bottom, thickness, color);
  canvas.line(cx - head * 0.78, bottom - head, cx, bottom, thickness, color);
  canvas.line(cx + head * 0.78, bottom - head, cx, bottom, thickness, color);
}

function makeTray(size) {
  const c = new Canvas(size, size);
  const unit = size / 32;
  drawArrow(c, 10.5 * unit, 6 * unit, 26 * unit, DOWN, 3.0 * unit);
  drawArrow(c, 21.5 * unit, 26 * unit, 6 * unit, UP, 3.0 * unit);
  return encodePng(size, size, c.resolve(size, size));
}

function makeIcon(size) {
  const c = new Canvas(size, size);
  const unit = size / 256;
  // 底：圆角方块 + 竖向渐变（逐条横带近似）
  c.roundRect(8 * unit, 8 * unit, 240 * unit, 240 * unit, 56 * unit, [12, 16, 27], 1);
  for (let i = 0; i < 240; i += 1) {
    const t = i / 239;
    const color = [
      Math.round(22 + (12 - 22) * t),
      Math.round(28 + (16 - 28) * t),
      Math.round(43 + (27 - 43) * t),
    ];
    c.roundRect(8 * unit, (8 + i) * unit, 240 * unit, 1.2 * unit, 0, color, 0.92);
  }
  // 顶部内高光
  c.roundRect(20 * unit, 16 * unit, 216 * unit, 3 * unit, 1.5 * unit, [255, 255, 255], 0.10);
  // 两条速度线
  c.roundRect(40 * unit, 186 * unit, 176 * unit, 8 * unit, 4 * unit, [255, 255, 255], 0.10);
  c.roundRect(40 * unit, 186 * unit, 108 * unit, 8 * unit, 4 * unit, DOWN, 0.85);
  c.roundRect(40 * unit, 202 * unit, 176 * unit, 8 * unit, 4 * unit, [255, 255, 255], 0.10);
  c.roundRect(40 * unit, 202 * unit, 62 * unit, 8 * unit, 4 * unit, UP, 0.75);
  // 上下箭头
  drawArrow(c, 86 * unit, 52 * unit, 152 * unit, DOWN, 22 * unit);
  drawArrow(c, 170 * unit, 152 * unit, 52 * unit, UP, 22 * unit);
  return encodePng(size, size, c.resolve(size, size));
}

/** ICO 容器：Vista 以后允许直接塞 PNG（宽高写 0 表示 256） */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;                        // 调色板
    entry[3] = 0;                        // reserved
    entry.writeUInt16LE(1, 4);           // colour planes
    entry.writeUInt16LE(32, 6);          // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

mkdirSync(OUT, { recursive: true });
const tray32 = makeTray(32);
const icon256 = makeIcon(256);
const icon64 = makeIcon(64);
const icon32 = makeIcon(32);
writeFileSync(join(OUT, 'tray.png'), tray32);
writeFileSync(join(OUT, 'icon.png'), icon256);
writeFileSync(join(OUT, 'icon-64.png'), icon64);
// 快捷方式与窗口图标都吃 .ico，PNG 它们不认
writeFileSync(join(OUT, 'icon.ico'), encodeIco([
  { size: 256, data: icon256 },
  { size: 64, data: icon64 },
  { size: 32, data: icon32 },
]));
console.log(`assets written to ${OUT}`);
