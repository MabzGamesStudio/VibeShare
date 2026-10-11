import { deflateSync } from 'node:zlib';

// Small generators for the demo network's sample content, so the demo needs no downloads.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG drawn by `pixel(x, y) → [r, g, b]`. */
export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** A soft two-colour gradient with a few glowing circles: thumbnails and cover art. */
export function artwork(seed: number, width = 480, height = 270): Buffer {
  let state = seed * 9301 + 49297;
  const random = () => ((state = (state * 9301 + 49297) % 233280) / 233280);
  const hue = random() * 360;
  const circles = Array.from({ length: 5 }, () => ({ x: random() * width, y: random() * height, r: 30 + random() * 120, hue: (hue + random() * 120) % 360 }));
  return png(width, height, (x, y) => {
    const t = (x / width + y / height) / 2;
    let [r, g, b] = hsl((hue + t * 60) % 360, 0.65, 0.25 + t * 0.2);
    for (const c of circles) {
      const d = Math.hypot(x - c.x, y - c.y) / c.r;
      if (d < 1) {
        const glow = (1 - d) * (1 - d) * 0.8;
        const [cr, cg, cb] = hsl(c.hue, 0.8, 0.65);
        r = r + (cr - r) * glow;
        g = g + (cg - g) * glow;
        b = b + (cb - b) * glow;
      }
    }
    return [r, g, b];
  });
}

export function dataUrl(image: Buffer): string {
  return `data:image/png;base64,${image.toString('base64')}`;
}

/** 16-bit mono PCM WAV of a gentle generated melody over a drone. */
export function melody(seconds: number, seed = 1, sampleRate = 44100): Buffer {
  const scale = [0, 2, 4, 7, 9, 12, 14, 16];
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const noteLength = 0.4;
  const notes = Array.from({ length: Math.ceil(seconds / noteLength) }, () => 220 * Math.pow(2, scale[Math.floor(random() * scale.length)] / 12));
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const n = Math.floor(t / noteLength);
    const local = t - n * noteLength;
    const envelope = Math.exp(-local * 6) * Math.min(1, local * 80);
    const lead = Math.sin(2 * Math.PI * notes[n] * t) * envelope * 0.35;
    const drone = (Math.sin(2 * Math.PI * 110 * t) + 0.5 * Math.sin(2 * Math.PI * 165 * t)) * 0.08 * (0.8 + 0.2 * Math.sin(t * 0.5));
    const fade = Math.min(1, t / 1.5, (seconds - t) / 1.5);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, (lead + drone) * fade)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function svgArt(seed: number): Buffer {
  let state = seed;
  const random = () => ((state = (state * 16807) % 2147483647) / 2147483647);
  const hue = Math.floor(random() * 360);
  const shapes = Array.from({ length: 28 }, () => {
    const x = Math.round(random() * 1600);
    const y = Math.round(random() * 900);
    const r = Math.round(20 + random() * 220);
    const h = (hue + Math.round(random() * 140)) % 360;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${h} 85% 60%)" opacity="${(0.15 + random() * 0.5).toFixed(2)}"/>`;
  }).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 12%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 22%)"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="18"/></filter></defs><rect width="1600" height="900" fill="url(#g)"/><g filter="url(#b)">${shapes}</g></svg>`
  );
}
