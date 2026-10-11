import { AlertTriangle, Compass } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FeedItem, FeedResponse } from '../../../src/shared/clientapi';
import { errorMessage } from '../api';
import { ContentCard } from './ContentCard';
import { Empty, Loading, Spinner } from './ui';

/** A grid of content from algorithm nodes, with "load more" and per-node errors. */
export function Feed({
  load,
  deps,
  empty,
}: {
  load: (cursor?: string) => Promise<FeedResponse>;
  deps: unknown[];
  empty?: ReactNode;
}) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [errors, setErrors] = useState<FeedResponse['errors']>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (next?: string) => {
      const mine = ++generation.current;
      setBusy(true);
      try {
        const page = await load(next);
        if (mine !== generation.current) return;
        setItems((current) => {
          const list = next ? [...(current ?? [])] : [];
          const seen = new Set(list.map((item) => item.id.split('~')[0]));
          for (const item of page.items) if (!seen.has(item.id.split('~')[0])) list.push(item);
          return list;
        });
        setCursor(page.cursor);
        setErrors(page.errors);
        setFailure(null);
      } catch (error) {
        if (mine === generation.current) setFailure(errorMessage(error));
      } finally {
        if (mine === generation.current) setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps
  );

  useEffect(() => {
    setItems(null);
    void fetchPage();
  }, [fetchPage]);

  if (failure && !items) return <div className="banner danger">{failure}</div>;
  if (!items) return <Loading />;
  return (
    <>
      {errors.length > 0 && (
        <div className="banner warn">
          <AlertTriangle size={18} />
          <div className="small">
            {errors.map((error) => (
              <div key={error.node + error.error}>
                <strong>{error.name}</strong>: {error.error}
              </div>
            ))}
          </div>
        </div>
      )}
      {items.length === 0 ? (
        (empty ?? (
          <Empty icon={<Compass size={42} />} title="Nothing here yet">
            <p>Your algorithm nodes returned no content for these filters.</p>
          </Empty>
        ))
      ) : (
        <div className="grid">
          {items.map((item) => (
            <ContentCard key={item.id} item={item} />
          ))}
        </div>
      )}
      {cursor && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 30 }}>
          <button onClick={() => fetchPage(cursor)} disabled={busy}>
            {busy ? <Spinner /> : null} Load more
          </button>
        </div>
      )}
    </>
  );
}
