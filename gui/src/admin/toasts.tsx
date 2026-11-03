// Bottom-right toasts for the admin console: every message pops up there (like the
// client's), and a button keeps the full history — scrollable, deletable, clearable.
import { Bell, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

export interface ToastEntry {
  id: number;
  at: string;
  text: string;
  kind: 'info' | 'error';
}

let nextId = 1;
let entries: ToastEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Shows one message as a toast at the bottom right and keeps it in the history. */
export function postToast(text: string, kind: 'info' | 'error' = 'info'): void {
  entries = [{ id: nextId++, at: new Date().toISOString(), text, kind }, ...entries].slice(0, 200);
  emit();
}

export function deleteToast(id: number): void {
  entries = entries.filter((entry) => entry.id !== id);
  emit();
}

export function clearToasts(): void {
  entries = [];
  emit();
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

/** The toasts at the bottom right, plus the button that opens their history. */
export function ToastArea() {
  const list = useToastFeed();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const live = list.filter((entry) => now - Date.parse(entry.at) < VISIBLE_MS).slice(0, 3);

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
              <button className="small" disabled={!list.length} onClick={() => clearToasts()}>
                <Trash2 size={13} /> Clear all
              </button>
              <button className="small ghost" onClick={() => setOpen(false)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
          </div>
          {list.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Nothing yet.
            </p>
          ) : (
            list.map((entry) => (
              <div key={entry.id} className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                <div className="small">
                  <span className="faint tiny">{new Date(entry.at).toLocaleTimeString()}</span>{' '}
                  <span style={entry.kind === 'error' ? { color: 'var(--danger)' } : undefined}>{entry.text}</span>
                </div>
                <button className="small ghost" title="Delete" onClick={() => deleteToast(entry.id)}>
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
          <button className="small ghost" onClick={() => deleteToast(entry.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        onClick={() => setOpen((value) => !value)}
        title="Recent messages"
        aria-label="Recent messages"
        style={{ display: 'flex', alignItems: 'center', boxShadow: '0 6px 24px rgba(0,0,0,.3)' }}
      >
        <Bell size={15} />
      </button>
    </div>
  );
}