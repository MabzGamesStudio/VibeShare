// Saving a cid into the user's own saved collection and assigning it to any number of
// named cid collections (kept per profile; Library → Saved cids lists them all).
import { Bookmark, Check, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SavedState } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { useApp } from '../state';
import { Modal } from './ui';

/**
 * The dialog behind the save button: the cid is saved (once), and its collections are
 * chosen — existing ones or brand-new names, which become collections right there.
 */
export function SaveCidModal({
  id,
  title,
  onClose,
  onSaved,
}: {
  id: string;
  title?: string;
  onClose: () => void;
  onSaved?: (state: SavedState) => void;
}) {
  const { toast } = useApp();
  const [saved, setSaved] = useState<SavedState | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [fresh, setFresh] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<SavedState>('/api/saved')
      .then((state) => {
        setSaved(state);
        setPicked(state.items.find((item) => item.id === id)?.collections ?? []);
      })
      .catch((e) => toast(errorMessage(e), 'error'));
  }, [id, toast]);
  useEffect(load, [load]);

  const toggle = (name: string) => setPicked((list) => (list.includes(name) ? list.filter((c) => c !== name) : [...list, name]));

  const store = async (collections: string[]) => {
    setBusy(true);
    try {
      const state = await api<SavedState>('/api/saved', { method: 'POST', body: { id, title, collections } });
      setSaved(state);
      setPicked(state.items.find((item) => item.id === id)?.collections ?? []);
      onSaved?.(state);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const unsave = async () => {
    setBusy(true);
    try {
      const state = await api<SavedState>(`/api/saved/${encodeURIComponent(id)}`, { method: 'DELETE' });
      onSaved?.(state);
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const known = saved?.collections ?? [];
  const isNew = (name: string) => !known.some((collection) => collection.id === name);
  const rows = [...known.map((collection) => ({ id: collection.id, name: collection.name })), ...picked.filter(isNew).map((name) => ({ id: name, name }))];

  return (
    <Modal
      title="Save to collections"
      onClose={onClose}
      actions={
        <>
          {saved?.items.some((item) => item.id === id) ? (
            <button className="ghost" disabled={busy} onClick={() => void unsave()}>
              <Trash2 size={15} /> Take out of saved
            </button>
          ) : null}
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          <button className="primary" disabled={busy} onClick={() => void store(picked)}>
            <Check size={16} /> Save
          </button>
        </>
      }
    >
      <div className="form-stack">
        <p className="small muted">
          A saved cid can sit in several collections at the same time. Ticking a name that does not exist yet makes the collection on the spot.
        </p>
        <div className="form-stack" style={{ gap: 6, maxHeight: 220, overflowY: 'auto' }}>
          {rows.length === 0 ? <p className="hint">No collections yet — type a name below to make the first one.</p> : null}
          {rows.map((collection) => (
            <label key={collection.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.includes(collection.id)} onChange={() => toggle(collection.id)} />
              <span>{collection.name}</span>
            </label>
          ))}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <input
            type="text"
            placeholder="New collection name"
            value={fresh}
            onChange={(e) => setFresh(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            disabled={!fresh.trim()}
            onClick={() => {
              toggle(fresh.trim());
              setFresh('');
            }}
          >
            <Plus size={15} /> Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The save button of any content carrying a cid: saves it and assigns its collections. */
export function SaveCidButton({
  id,
  title,
  className = 'button',
  compact = false,
  onSaved,
}: {
  id: string;
  title?: string;
  className?: string;
  compact?: boolean;
  onSaved?: (state: SavedState) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Save this cid to a collection">
        <Bookmark size={16} /> {compact ? '' : 'Save'}
      </button>
      {open ? <SaveCidModal id={id} title={title} onClose={() => setOpen(false)} onSaved={onSaved} /> : null}
    </>
  );
}