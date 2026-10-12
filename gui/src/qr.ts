// QR codes as SVG: a plain black-and-white code, or a colored one with a gradient,
// rounded modules, rounded finder patterns and an optional logo in the middle.
import { encode, QrCodeDataType } from 'uqr';

export interface QrStyle {
  shape: 'square' | 'rounded' | 'dots';
  /** One color, or the two ends of a diagonal gradient. */
  colors: string[];
  /** Color of the three corner squares; the module color when unset. */
  eyes?: string;
  background: string;
  /** A logo in the middle (the code then uses the highest error correction). */
  logo: boolean;
}

export const PLAIN_QR: QrStyle = { shape: 'square', colors: ['#000000'], background: '#ffffff', logo: false };

export const QR_PALETTES: { name: string; colors: string[]; eyes: string }[] = [
  { name: 'VibeShare', colors: ['#7c3aed', '#db2777'], eyes: '#5b21b6' },
  { name: 'Ocean', colors: ['#0369a1', '#0f766e'], eyes: '#0c4a6e' },
  { name: 'Sunset', colors: ['#c2410c', '#be123c'], eyes: '#9a3412' },
  { name: 'Forest', colors: ['#15803d', '#0e7490'], eyes: '#14532d' },
  { name: 'Midnight', colors: ['#1e3a8a', '#6d28d9'], eyes: '#172554' },
  { name: 'Ink', colors: ['#111827'], eyes: '#111827' },
];

export const COLOR_QR: QrStyle = { shape: 'dots', colors: QR_PALETTES[0].colors, eyes: QR_PALETTES[0].eyes, background: '#ffffff', logo: true };

const QUIET = 4;

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h / 2);
  if (radius <= 0) return `M${x} ${y}h${w}v${h}h${-w}z`;
  return (
    `M${x + radius} ${y}h${w - 2 * radius}a${radius} ${radius} 0 0 1 ${radius} ${radius}` +
    `v${h - 2 * radius}a${radius} ${radius} 0 0 1 ${-radius} ${radius}` +
    `h${-(w - 2 * radius)}a${radius} ${radius} 0 0 1 ${-radius} ${-radius}` +
    `v${-(h - 2 * radius)}a${radius} ${radius} 0 0 1 ${radius} ${-radius}z`
  );
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** An SVG document with the QR code of `text`. */
export function qrSvg(text: string, style: QrStyle, pixels = 512): string {
  const qr = encode(text, { ecc: style.logo ? 'H' : style.shape === 'square' ? 'M' : 'Q', border: 0 });
  const n = qr.size;
  const total = n + QUIET * 2;
  const gradient = style.colors.length > 1;
  const fill = gradient ? 'url(#vs-qr-fill)' : style.colors[0];
  const eyes = style.eyes ?? fill;

  // The logo covers the middle; the error correction restores what it hides.
  const logoSize = style.logo ? Math.max(5, Math.round(n * 0.22) | 1) : 0;
  const logoStart = Math.floor((n - logoSize) / 2);
  const underLogo = (x: number, y: number) =>
    style.logo && x >= logoStart - 1 && x <= logoStart + logoSize && y >= logoStart - 1 && y <= logoStart + logoSize;

  let modules = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.data[y][x] || qr.types[y][x] === QrCodeDataType.Position || underLogo(x, y)) continue;
      const px = x + QUIET;
      const py = y + QUIET;
      if (style.shape === 'dots') {
        const r = 0.43;
        modules += `M${px + 0.5 - r} ${py + 0.5}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
      } else if (style.shape === 'rounded') {
        modules += roundedRect(px + 0.05, py + 0.05, 0.9, 0.9, 0.3);
      } else {
        modules += `M${px} ${py}h1v1h-1z`;
      }
    }
  }

  // The three finder patterns ("eyes"): a ring (even-odd fill punches its hole) and a centre.
  const ring = style.shape === 'square' ? [0, 0] : [2.2, 1.4];
  const centre = style.shape === 'square' ? 0 : 1;
  let ringPath = '';
  let centrePath = '';
  for (const [fx, fy] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ]) {
    const x = fx + QUIET;
    const y = fy + QUIET;
    ringPath += roundedRect(x, y, 7, 7, ring[0]) + roundedRect(x + 1, y + 1, 5, 5, ring[1]);
    centrePath += roundedRect(x + 2, y + 2, 3, 3, centre);
  }

  let logo = '';
  if (style.logo) {
    const x = logoStart + QUIET;
    const size = logoSize;
    const c = x + size / 2;
    const s = size * 0.3;
    // A four-pointed sparkle, like the VibeShare logo.
    const star = `M${c} ${c - s}Q${c + s * 0.18} ${c - s * 0.18} ${c + s} ${c}Q${c + s * 0.18} ${c + s * 0.18} ${c} ${c + s}Q${c - s * 0.18} ${c + s * 0.18} ${c - s} ${c}Q${c - s * 0.18} ${c - s * 0.18} ${c} ${c - s}z`;
    logo =
      `<path d="${roundedRect(x, x, size, size, size * 0.24)}" fill="${fill}"/>` +
      `<path d="${star}" fill="${escapeXml(style.background)}"/>`;
  }

  const defs = gradient
    ? `<defs><linearGradient id="vs-qr-fill" x1="0" y1="0" x2="1" y2="1">${style.colors
        .map((color, i) => `<stop offset="${i / (style.colors.length - 1)}" stop-color="${escapeXml(color)}"/>`)
        .join('')}</linearGradient></defs>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixels}" height="${pixels}" shape-rendering="${style.shape === 'square' ? 'crispEdges' : 'geometricPrecision'}">` +
    defs +
    `<rect width="${total}" height="${total}" fill="${escapeXml(style.background)}"/>` +
    `<path d="${modules}" fill="${escapeXml(fill)}"/>` +
    `<path d="${ringPath}" fill="${escapeXml(eyes)}" fill-rule="evenodd"/>` +
    `<path d="${centrePath}" fill="${escapeXml(eyes)}"/>` +
    logo +
    `</svg>`
  );
}

/** Renders an SVG document to a PNG. */
export function svgToPng(svg: string, pixels = 1024): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = pixels;
      canvas.height = pixels;
      const context = canvas.getContext('2d');
      if (!context) return reject(new Error('Canvas is not available'));
      context.drawImage(image, 0, 0, pixels, pixels);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not draw the image'))), 'image/png');
    };
    image.onerror = () => reject(new Error('Could not draw the image'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
