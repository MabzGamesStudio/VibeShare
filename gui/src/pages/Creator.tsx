import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { CreatorView } from '../../../src/shared/clientapi';
import { CREATOR_KIND_LABELS } from '../../../src/shared/taxonomy';
import { api, errorMessage } from '../api';
import { ContentCard } from '../components/ContentCard';
import { Avatar, CopyButton, Empty, Loading } from '../components/ui';
import { useApp } from '../state';

export function CreatorPage() {
  const { id = '' } = useParams();
  const { state, refresh, toast } = useApp();
  const [view, setView] = useState<CreatorView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    api<CreatorView>(`/api/creators/${encodeURIComponent(id)}`)
      .then(setView)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  if (error) return <div className="page"><div className="banner danger">{error}</div></div>;
  if (!view || !state) return <div className="page"><Loading /></div>;
  const { creator } = view;
  const subscribed = state.subscriptions.some((s) => s.id === creator.id);

  const toggle = async () => {
    try {
      if (subscribed) await api(`/api/subscriptions/${encodeURIComponent(creator.id)}`, { method: 'DELETE' });
      else await api('/api/subscriptions', { body: { id: creator.id, name: creator.name, kind: creator.kind } });
      await refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ gap: 20, marginBottom: 30 }}>
        <Avatar name={creator.name} id={creator.id} large />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{creator.name}</h1>
          <div className="row small muted" style={{ marginTop: 6 }}>
            <span className="badge">{CREATOR_KIND_LABELS[creator.kind]}</span>
            {creator.keys?.length ? <span className="badge ok">Verified key</span> : <span className="badge">Name only</span>}
            <span>{view.items.length} item{view.items.length === 1 ? '' : 's'}</span>
          </div>
          {creator.description && <p className="muted" style={{ marginTop: 10 }}>{creator.description}</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className={subscribed ? '' : 'primary'} onClick={toggle}>
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </button>
            <CopyButton text={creator.id} label="Copy creator id" small={false} />
          </div>
        </div>
      </div>
      {view.items.length ? (
        <div className="grid">
          {view.items.map((item) => (
            <ContentCard key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <Empty title="No content listed">
          <p>None of your algorithm nodes lists content by this creator.</p>
        </Empty>
      )}
    </div>
  );
}
