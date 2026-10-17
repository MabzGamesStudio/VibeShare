import { ExternalLink, Eye, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FeedItem, MetadataField } from '../../../../src/shared/clientapi';
import { platformOf } from '../../../../src/shared/sources';
import { FORMAT_LABELS, RATING_LABELS } from '../../../../src/shared/taxonomy';
import { creatorPath, formatDuration, timeAgo, watchPath } from '../../util';
import { Avatar, WatchedBadge } from '../ui';

export function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e4) return `${Math.round(value / 1e3)}K`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

/** One piece of metadata, or null when the item has none. */
export function FieldValue({ item, field }: { item: FeedItem; field: MetadataField }) {
  switch (field) {
    case 'creator':
      return item.creator ? (
        <Link to={creatorPath(item.creator.id)} className="field-creator" onClick={(e) => e.stopPropagation()}>
          <Avatar name={item.creator.name} id={item.creator.id} icon={item.creator.icon} /> {item.creator.name}
        </Link>
      ) : null;
    case 'platform': {
      const platform = platformOf(item.id);
      const page = item.pageUrl ?? platform.page;
      return page ? (
        <a className="field-platform" href={page} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {platform.name} <ExternalLink size={11} />
        </a>
      ) : (
        <span className="field-platform">{platform.name}</span>
      );
    }
    case 'likes': {
      // VibeShare votes, or the platform's own count while nobody voted here.
      const fromPlatform = !item.stats.likes && item.stats.platformLikes !== undefined;
      return (
        <span title={fromPlatform ? `Likes on ${platformOf(item.id).name}` : 'Likes on VibeShare'}>
          <ThumbsUp size={12} /> {compact(fromPlatform ? item.stats.platformLikes! : item.stats.likes)}
        </span>
      );
    }
    case 'dislikes':
      return (
        <span>
          <ThumbsDown size={12} /> {compact(item.stats.dislikes)}
        </span>
      );
    case 'views':
      return item.stats.views !== undefined ? (
        <span>
          <Eye size={12} /> {compact(item.stats.views)}
        </span>
      ) : null;
    case 'published':
      return <span>{timeAgo(item.publishedAt)}</span>;
    case 'duration':
      return item.durationSeconds ? <span>{formatDuration(item.durationSeconds)}</span> : null;
    case 'format':
      return <span>{FORMAT_LABELS[item.format]}</span>;
    case 'rating':
      return <span>{RATING_LABELS[item.rating]}</span>;
    case 'tags':
      return item.tags.length ? <span>{item.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ')}</span> : null;
    case 'topics':
      return item.topics.length ? <span>{item.topics.slice(0, 3).join(', ')}</span> : null;
    case 'via':
      return <span>via {item.viaName}</span>;
    default:
      return null;
  }
}

/**
 * The metadata a page shows for an item, in the order the user chose: the title (if
 * chosen) as the heading, the description as a short paragraph, the rest on a line.
 */
export function Fields({ item, fields, variant = 'card' }: { item: FeedItem; fields: MetadataField[]; variant?: 'card' | 'overlay' | 'compact' }) {
  const rest = fields.filter((field) => field !== 'title' && field !== 'description');
  const showAvatar = variant === 'card' && fields.includes('creator') && item.creator;
  return (
    <div className={`fields fields-${variant}`}>
      {showAvatar && (
        <Link to={creatorPath(item.creator!.id)} className="fields-avatar">
          <Avatar name={item.creator!.name} id={item.creator!.id} />
        </Link>
      )}
      <div className="fields-body">
        {fields.includes('title') && (
          <Link to={watchPath(item.id)} className="content-title" title={item.title}>
            {item.title}
          </Link>
        )}
        {(rest.length > 0 || item.seen) && (
          <div className="fields-meta">
            {rest.map((field) => (
              <FieldValue key={field} item={item} field={field} />
            ))}
            {item.seen && <WatchedBadge />}
          </div>
        )}
        {fields.includes('description') && item.description && <p className="fields-description">{item.description}</p>}
      </div>
    </div>
  );
}
