import { Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FeedResponse } from '../../../src/shared/clientapi';
import { api } from '../api';
import { Feed } from '../components/Feed';
import { SubsCarousel } from '../components/SubsCarousel';
import { Empty } from '../components/ui';
import { useApp } from '../state';

export function SubscriptionsPage() {
  const { state } = useApp();
  if (!state) return null;
  const subscriptions = state.subscriptions;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Subscriptions</h1>
          <p>The newest content from the creators you follow, from every algorithm node you use.</p>
        </div>
      </div>
      <SubsCarousel subscriptions={subscriptions} />
      {subscriptions.length === 0 ? (
        <Empty icon={<Users size={42} />} title="No subscriptions yet">
          <p>
            Open any content or creator page and press Subscribe — or <Link to="/subscriptions/all">add subscriptions</Link> from the creators you
            know.
          </p>
        </Empty>
      ) : (
        <Feed
          deps={[subscriptions.map((s) => s.id).join()]}
          load={(cursor) => api<FeedResponse>('/api/subscriptions/feed', { body: { cursor } })}
        />
      )}
    </div>
  );
}
