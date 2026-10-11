// Draws the app icon (desktop/build/icon.png): the favicon's gradient tile with a white "V".
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { png } from '../src/demo/media.js';

const size = 1024;
const radius = 230;
const stroke = 112;
const a = [288, 320];
const b = [512, 736];
const c = [736, 320];

function segmentDistance(x: number, y: number, p: number[], q: number[]): number {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (p[0] + t * dx), y - (p[1] + t * dy));
}

function insideRounded(x: number, y: number): number {
  const cx = Math.max(radius, Math.min(size - radius, x));
  const cy = Math.max(radius, Math.min(size - radius, y));
  return Math.max(0, Math.min(1, radius - Math.hypot(x - cx, y - cy) + 0.5));
}

const image = png(size, size, (x, y) => {
  const t = (x + y) / (2 * size);
  const bg = [139 + (236 - 139) * t, 92 + (72 - 92) * t, 246 + (153 - 246) * t];
  const d = Math.min(segmentDistance(x, y, a, b), segmentDistance(x, y, b, c));
  const v = Math.max(0, Math.min(1, stroke / 2 - d + 0.5));
  const color = bg.map((channel) => channel + (255 - channel) * v);
  return [color[0], color[1], color[2], 255 * insideRounded(x, y)];
}, true);
writeFileSync(join(resolve(import.meta.dirname, '..'), 'desktop', 'build', 'icon.png'), image);
console.log('desktop/build/icon.png written');
