export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function timeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 60) return 'just now';
  const steps: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];
  let label = 'minute';
  let size = 60;
  for (const [step, name] of steps) {
    if (seconds >= step) {
      size = step;
      label = name;
    }
  }
  const count = Math.floor(seconds / size);
  return `${count} ${label}${count === 1 ? '' : 's'} ago`;
}

export function shortId(id: string | undefined, length = 10): string {
  if (!id) return '';
  return id.length > length + 4 ? `${id.slice(0, length)}…` : id;
}

/** A stable gradient for content without a thumbnail. */
export function gradientFor(text: string): string {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 50) % 360} 75% 35%))`;
}

export function watchPath(id: string): string {
  return `/watch/${encodeURIComponent(id)}`;
}

export function creatorPath(id: string): string {
  return `/creator/${encodeURIComponent(id)}`;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

export function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
