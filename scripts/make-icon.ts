// Draws the app icons: the favicon's gradient tile with a white "V" for the desktop app
// (desktop/build/icon.png), the same full-bleed and opaque for iOS (which rounds the
// corners itself), and the iOS launch screen (the tile on the app's dark background).
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
const root = resolve(import.meta.dirname, '..');
writeFileSync(join(root, 'desktop', 'build', 'icon.png'), image);
console.log('desktop/build/icon.png written');

/** The tile's colour at (x, y) of a size×size tile, without the rounded corners. */
function tile(x: number, y: number, scale = 1): [number, number, number] {
  const sx = x / scale;
  const sy = y / scale;
  const t = (sx + sy) / (2 * size);
  const bg = [139 + (236 - 139) * t, 92 + (72 - 92) * t, 246 + (153 - 246) * t];
  const d = Math.min(segmentDistance(sx, sy, a, b), segmentDistance(sx, sy, b, c));
  // (Anti-aliased over half a pixel of the output.)
  const v = Math.max(0, Math.min(1, (stroke / 2 - d) * scale + 0.5));
  return bg.map((channel) => channel + (255 - channel) * v) as [number, number, number];
}

const assets = join(root, 'mobile', 'ios', 'App', 'App', 'Assets.xcassets');
writeFileSync(join(assets, 'AppIcon.appiconset', 'AppIcon-512@2x.png'), png(size, size, (x, y) => tile(x, y)));
console.log('iOS app icon written');

// Launch screen: a 2732² image shown "aspect fill", so the middle is what every screen shows.
const splashSize = 2732;
const logo = 520;
const scale = logo / size;
const left = (splashSize - logo) / 2;
const background: [number, number, number] = [13, 15, 20];
const corner = radius * scale;
const splash = png(splashSize, splashSize, (x, y) => {
  const lx = x - left;
  const ly = y - left;
  if (lx < 0 || ly < 0 || lx >= logo || ly >= logo) return background;
  const cx = Math.max(corner, Math.min(logo - corner, lx));
  const cy = Math.max(corner, Math.min(logo - corner, ly));
  const inside = Math.max(0, Math.min(1, corner - Math.hypot(lx - cx, ly - cy) + 0.5));
  const color = tile(lx, ly, scale);
  return color.map((channel, i) => background[i] + (channel - background[i]) * inside) as [number, number, number];
});
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  writeFileSync(join(assets, 'Splash.imageset', name), splash);
}
console.log('iOS launch screen written');
