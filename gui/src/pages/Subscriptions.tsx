import { Users, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FeedResponse, Subscription } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { Feed } from '../components/Feed';
import { Avatar, Empty } from '../components/ui';
import { useApp } from '../state';
import { creatorPath } from '../util';

export function SubscriptionsPage() {
  const { state, refresh, toast } = useApp();
  if (!state) return null;
  const subscriptions = state.subscriptions;

  const unsubscribe = async (subscription: Subscription) => {
    try {
      await api(`/api/subscriptions/${encodeURIComponent(subscription.id)}`, { method: 'DELETE' });
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Subscriptions</h1>
          <p>The newest content from the creators you follow, from every algorithm node you use.</p>
        </div>
      </div>
      {subscriptions.length === 0 ? (
        <Empty icon={<Users size={42} />} title="No subscriptions yet">
          <p>Open any content or creator page and press Subscribe.</p>
        </Empty>
      ) : (
        <>
          <div className="chips" style={{ marginBottom: 26 }}>
            {subscriptions.map((subscription) => (
              <div key={subscription.id} className="chip row" style={{ gap: 8, paddingLeft: 6 }}>
                <Link to={creatorPath(subscription.id)} className="row" style={{ gap: 8 }}>
                  <div style={{ transform: 'scale(0.7)', margin: -6 }}>
                    <Avatar name={subscription.name} id={subscription.id} />
                  </div>
                  {subscription.name}
                </Link>
                <button className="ghost icon small" onClick={() => unsubscribe(subscription)} aria-label={`Unsubscribe from ${subscription.name}`}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <Feed
            deps={[subscriptions.map((s) => s.id).join()]}
            load={(cursor) => api<FeedResponse>('/api/subscriptions/feed', { body: { cursor } })}
          />
        </>
      )}
    </div>
  );
}
