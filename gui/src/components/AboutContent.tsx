// The "Content data" table: the free-form key/value pairs of one piece of content.
// Read-only in the client's About dialog; with `onSave` the same table adds, edits and
// deletes pairs (the whole map goes back in one save). The list controls match the
// other console lists: a search over keys AND values, "Show as" pagination or lazy
// loading, items per page, Previous / page x of y / Next at both ends, and a
// skip-to-page input with a Go button.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export function ContentDataTab({ data, onSave }: { data?: Record<string, string>; onSave?: (data: Record<string, string>) => void | Promise<void> }) {
  const [pairs, setPairs] = useState<Record<string, string>>(data ?? {});
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'pages' | 'lazy'>('pages');
  const [perPage, setPerPage] = useState(10);
  const [page, setPage] = useState(0);
  const [lazy, setLazy] = useState(10);
  const [skip, setSkip] = useState('');
  const [editing, setEditing] = useState<{ from: string; key: string; value: string } | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  useEffect(() => {
    setPairs(data ?? {});
  }, [data]);

  const needle = search.trim().toLowerCase();
  const entries = useMemo(() => Object.entries(pairs), [pairs]);
  const filtered = needle ? entries.filter(([key, value]) => key.toLowerCase().includes(needle) || value.toLowerCase().includes(needle)) : entries;
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pages - 1);
  const shown = mode === 'pages' ? filtered.slice(current * perPage, (current + 1) * perPage) : filtered.slice(0, lazy);

  /** Sends the whole map back (a pair is dropped by leaving its key out). */
  const commit = async (next: Record<string, string>) => {
    setPairs(next);
    setEditing(null);
    await onSave?.(next);
  };

  const pager = (
    <div className="row between">
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="small" disabled={current === 0 || mode === 'lazy'} onClick={() => setPage(current - 1)}>
          <ChevronLeft size={14} /> Previous
        </button>
        <span className="tiny faint">{`page ${current + 1} of ${pages}`}</span>
        <button
          type="button"
          className="small"
          disabled={current >= pages - 1 || mode === 'lazy'}
          onClick={() => setPage(current + 1)}
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input
          type="number"
          min={1}
          max={pages}
          value={skip}
          placeholder="page #"
          aria-label="Skip to page"
          style={{ maxWidth: 90 }}
          onChange={(e) => setSkip(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setPage(Math.min(pages - 1, Math.max(0, (Number(skip) || 1) - 1)));
          }}
        />
        <button
          type="button"
          className="small"
          disabled={mode === 'lazy'}
          onClick={() => setPage(Math.min(pages - 1, Math.max(0, (Number(skip) || 1) - 1)))}
        >
          Go
        </button>
      </div>
    </div>
  );

  return (
    <div className="form-stack">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          type="search"
          value={search}
          placeholder="Search keys and values"
          aria-label="Search keys and values"
          style={{ flex: 1, minWidth: 160 }}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
            setLazy(perPage);
          }}
        />
        <select
          value={mode}
          style={{ width: 'auto' }}
          onChange={(e) => {
            setMode(e.target.value as 'pages' | 'lazy');
            setLazy(perPage);
          }}
        >
          <option value="pages">Pagination</option>
          <option value="lazy">Lazy loading</option>
        </select>
        <input
          type="number"
          min={5}
          max={500}
          style={{ maxWidth: 92 }}
          defaultValue={perPage}
          aria-label="Items per page"
          onBlur={(e) => {
            const next = Math.round(Number(e.target.value));
            if (Number.isFinite(next) && next >= 5 && next <= 500 && next !== perPage) {
              setPerPage(next);
              setLazy(next);
              setPage(0);
            }
          }}
        />
        <span className="hint">items per page</span>
      </div>
      {onSave && (
        <div className="row" style={{ gap: 6 }}>
          <input
            type="text"
            className="mono"
            value={newKey}
            placeholder="Key (up to 80 characters)"
            aria-label="New pair key"
            style={{ flex: 1 }}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input
            type="text"
            value={newValue}
            placeholder="Value (up to 1000 characters)"
            aria-label="New pair value"
            style={{ flex: 2 }}
            onChange={(e) => setNewValue(e.target.value)}
          />
          <button
            type="button"
            className="small primary"
            disabled={!newKey.trim() || Object.hasOwn(pairs, newKey.trim())}
            onClick={() => {
              const key = newKey.trim().slice(0, 80);
              if (!key) return;
              void commit({ ...pairs, [key]: newValue.slice(0, 1000) });
              setNewKey('');
              setNewValue('');
            }}
          >
            Add
          </button>
        </div>
      )}
      {filtered.length > 0 && pager}
      {filtered.length === 0 ? (
        <p className="small muted">{needle ? 'No pair matches the search.' : 'No content data on this one yet.'}</p>
      ) : (
        <table className="table">
          <tbody>
            {shown.map(([key, value]) =>
              editing?.from === key ? (
                <tr key={key}>
                  <td>
                    <input
                      type="text"
                      className="mono"
                      value={editing.key}
                      aria-label="Pair key"
                      onChange={(e) => setEditing({ ...editing, key: e.target.value })}
                    />
                  </td>
                  <td>
                    <input type="text" value={editing.value} aria-label="Pair value" onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        type="button"
                        className="small primary"
                        disabled={!editing.key.trim()}
                        onClick={() => {
                          const to = editing.key.trim().slice(0, 80);
                          const next: Record<string, string> = {};
                          for (const [from, val] of entries) next[from === key ? to : from] = from === key ? editing.value.slice(0, 1000) : val;
                          void commit(next);
                        }}
                      >
                        Save
                      </button>
                      <button type="button" className="small ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={key}>
                  <td className="mono small" style={{ width: '35%' }}>
                    {key}
                  </td>
                  <td className="small">{value}</td>
                  {onSave && (
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button type="button" className="small" onClick={() => setEditing({ from: key, key, value })}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="small"
                          onClick={() => {
                            const next = { ...pairs };
                            delete next[key];
                            void commit(next);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              )
            )}
          </tbody>
        </table>
      )}
      {filtered.length > 0 && pager}
      {mode === 'lazy' && shown.length < filtered.length && (
        <button
          type="button"
          className="small"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setLazy((count) => count + perPage)}
        >
          Show more ({shown.length} of {filtered.length})
        </button>
      )}
    </div>
  );
}
