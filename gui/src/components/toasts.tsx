// Bottom-right toasts for the client: every message pops up there, and a bell button
// keeps the full history — searchable, deletable, clearable — the same messages system as
// the content and search nodes' consoles. A copy is kept by the client only when the user
// turns that on (Settings → History → Toast messages; off by default).
import { Bell, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ToastMessage } from '../../../src/shared/clientapi';
import { api } from '../api';

export interface ToastEntry {
  id: string;
  at: string;
  text: string;
  kind: ToastMessage['kind'];
}

let nextId = 1;
let entries: ToastEntry[] = [];
const listeners = new Set<() => void>();
/** Whether the client keeps a copy of every message (the History settings say). */
let saving = false;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Shows one message as a toast at the bottom right and keeps it in the history. */
export function postToast(text: string, kind: ToastMessage['kind'] = 'info'): void {
  const at = new Date().toISOString();
  entries = [{ id: `t${nextId++}`, at, text, kind }, ...entries].slice(0, 200);
  emit();
  // The client stores a copy only when the user turned that on (off by default).
  if (saving) void api('/api/toasts', { body: { text, kind, at } }).catch(() => undefined);
}

export function deleteToast(id: string): void {
  entries = entries.filter((entry) => entry.id !== id);
  emit();
}

export function clearToasts(): void {
  entries = [];
  emit();
}

/** Whether saved copies are kept — set from the settings whenever they change. */
export function setToastSaving(on: boolean): void {
  saving = on;
}

function useToastFeed(): ToastEntry[] {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return entries;
}

/** How long a message stays on screen before it is only kept in the history. */
const VISIBLE_MS = 6000;

/** The toasts at the bottom right, plus the bell button that opens their history. */
export function ToastArea({ saving: keeps, showIcon }: { saving: boolean; showIcon: boolean }) {
  const list = useToastFeed();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState<ToastMessage[]>([]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // With saved copies on, the history is what the client kept (searchable, as in the
  // History page); without it, this session's messages are all there is.
  useEffect(() => {
    if (!keeps || !open) return;
    api<{ items: ToastMessage[] }>(`/api/toasts${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
      .then((answer) => setSaved(answer.items))
      .catch(() => setSaved([]));
  }, [keeps, open, query, list.length]);
  const live = list.filter((entry) => now - Date.parse(entry.at) < VISIBLE_MS).slice(0, 3);
  const past: ToastEntry[] = keeps ? saved.map((item) => ({ id: item.id, at: item.at, text: item.text, kind: item.kind })) : list;
  const needle = query.trim().toLowerCase();
  const shown = keeps ? past : needle ? past.filter((entry) => entry.text.toLowerCase().includes(needle)) : past;

  const remove = (entry: ToastEntry) => {
    deleteToast(entry.id);
    if (keeps) void api(`/api/toasts/${encodeURIComponent(entry.id)}`, { method: 'DELETE' }).catch(() => undefined);
  };
  const clear = () => {
    clearToasts();
    if (keeps) void api('/api/toasts', { method: 'DELETE' }).catch(() => undefined);
    setSaved([]);
  };

  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
      {open && (
        <div
          className="card form-stack"
          style={{ width: 380, maxHeight: '60vh', overflowY: 'auto', padding: 10, boxShadow: '0 8px 30px rgba(0,0,0,.35)' }}
        >
          <div className="row between">
            <strong>Messages</strong>
            <div className="row" style={{ gap: 6 }}>
              <button className="small" disabled={past.length === 0} onClick={clear}>
                <Trash2 size={13} /> Clear all
              </button>
              <button className="small ghost" onClick={() => setOpen(false)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
          </div>
          <input
            type="search"
            value={query}
            placeholder="Search messages"
            aria-label="Search messages"
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Nothing yet.
            </p>
          ) : (
            shown.map((entry) => (
              <div key={entry.id} className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                <div className="small">
                  <span className="faint tiny">{new Date(entry.at).toLocaleTimeString()}</span>{' '}
                  <span style={entry.kind === 'error' ? { color: 'var(--danger)' } : undefined}>{entry.text}</span>
                </div>
                <button className="small ghost" title="Delete" onClick={() => remove(entry)}>
                  <X size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {live.map((entry) => (
        <div
          key={entry.id}
          className="card row between"
          style={{ width: 320, padding: '8px 10px', gap: 8, boxShadow: '0 6px 24px rgba(0,0,0,.3)' }}
        >
          <span className="small" style={{ overflowWrap: 'anywhere' }}>
            {entry.text}
          </span>
          <button className="small ghost" onClick={() => remove(entry)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
      {showIcon && (
        <button
          onClick={() => setOpen((value) => !value)}
          title="Recent messages"
          aria-label="Recent messages"
          style={{ display: 'flex', alignItems: 'center', boxShadow: '0 6px 24px rgba(0,0,0,.3)' }}
        >
          <Bell size={15} />
        </button>
      )}
    </div>
  );
}