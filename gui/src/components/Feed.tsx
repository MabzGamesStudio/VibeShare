import { AlertTriangle, Compass } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FeedResponse, PageConfig } from '../../../src/shared/clientapi';
import { presetPage } from '../../../src/shared/clientdefaults';
import { GridLayout } from './feed/Cards';
import { usePaged, useSentinel } from './feed/usePaged';
import { Empty, Spinner } from './ui';

/** How cards look outside configurable pages (search, subscriptions, creators). */
export const CARD_PAGE: PageConfig = presetPage('home');

/** A grid of content from algorithm nodes that loads more as you scroll, with per-node errors. */
export function Feed({ load, deps, empty }: { load: (cursor?: string) => Promise<FeedResponse>; deps: unknown[]; empty?: ReactNode }) {
  const paged = usePaged(load, JSON.stringify(deps));
  const sentinel = useSentinel(paged.loadMore, !paged.done, paged.items.length);
  return (
    <>
      {paged.errors.length > 0 && (
        <div className="banner warn">
          <AlertTriangle size={18} />
          <div className="small">
            {paged.errors.map((error) => (
              <div key={error.node + error.error}>
                <strong>{error.name}</strong>: {error.error}
              </div>
            ))}
          </div>
        </div>
      )}
      {paged.failure && !paged.items.length ? (
        <div className="banner danger">{paged.failure}</div>
      ) : paged.items.length === 0 && !paged.loading ? (
        (empty ?? (
          <Empty icon={<Compass size={42} />} title="Nothing here yet">
            <p>Your algorithm nodes returned no content for these filters.</p>
          </Empty>
        ))
      ) : (
        <GridLayout items={paged.items} page={CARD_PAGE} />
      )}
      <div ref={sentinel} className="sentinel">
        {paged.loading && <Spinner />}
      </div>
    </>
  );
}
