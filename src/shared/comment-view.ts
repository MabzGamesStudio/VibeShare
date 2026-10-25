// Presentation-only helpers for the verified comment chain. Browser-safe.
import type { ChainEntry, CommentEntry } from './comments.js';

export type CommentDateDisplay = 'relative' | 'local' | 'iso' | 'hidden';

export interface CommentThread {
  entry: CommentEntry;
  replies: CommentThread[];
}

/** Parents own their replies visually even when a reply arrived later in the chain. */
export function commentThreads(entries: ChainEntry[], root: string): CommentThread[] {
  const comments = entries.filter((entry): entry is CommentEntry => !('removed' in entry));
  const nodes = new Map(comments.map((entry) => [entry.id, { entry, replies: [] } as CommentThread]));
  const roots: CommentThread[] = [];
  for (const node of nodes.values()) {
    const parent = node.entry.replyFrom === root ? undefined : nodes.get(node.entry.replyFrom);
    if (parent && parent !== node) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

export function formatCommentDate(time: string, display: CommentDateDisplay, now = Date.now()): string {
  if (!time || display === 'hidden') return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return time;
  if (display === 'iso') return date.toISOString();
  if (display === 'local') {
    if (/^\d{4}$/.test(time)) return time;
    if (/^\d{4}-\d{2}-\d{2}$/.test(time)) return date.toLocaleDateString();
    return date.toLocaleString();
  }
  const seconds = Math.round((date.getTime() - now) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 45) return 'just now';
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [365 * 86400, 'year'],
    [30 * 86400, 'month'],
    [7 * 86400, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  const unit = units.find(([size]) => absolute >= size);
  if (!unit) return date.toLocaleDateString();
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(seconds / unit[0]), unit[1]);
}
