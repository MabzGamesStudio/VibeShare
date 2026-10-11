import { Ban, BookOpen, Film, Gamepad2, Image, Music, Package, Podcast, Radio, Smartphone, FileText, Headphones, File } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FeedItem } from '../../../src/shared/clientapi';
import { FORMAT_LABELS, RATING_LABELS, type Format } from '../../../src/shared/taxonomy';
import { creatorPath, formatDuration, gradientFor, timeAgo, watchPath } from '../util';
import { Avatar } from './ui';

export const FORMAT_ICONS: Record<Format, typeof Film> = {
  video: Film,
  'short-video': Smartphone,
  live: Radio,
  music: Music,
  audio: Headphones,
  podcast: Podcast,
  image: Image,
  article: FileText,
  game: Gamepad2,
  software: Package,
  book: BookOpen,
  file: File,
  other: File,
};

export function FormatIcon({ format, size = 18 }: { format: Format; size?: number }) {
  const Icon = FORMAT_ICONS[format] ?? File;
  return <Icon size={size} />;
}

export function Thumbnail({ item }: { item: Pick<FeedItem, 'id' | 'title' | 'format' | 'durationSeconds' | 'thumbnailUrl' | 'rating'> }) {
  return (
    <div className="thumb" style={item.thumbnailUrl ? undefined : { background: gradientFor(item.id) }}>
      {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <FormatIcon format={item.format} size={42} />}
      <span className="thumb-format badge">
        <FormatIcon format={item.format} size={12} /> {FORMAT_LABELS[item.format]}
      </span>
      <div className="thumb-overlay">
        {item.rating !== 'all' && <span className="thumb-label">{RATING_LABELS[item.rating]}</span>}
        {item.durationSeconds ? <span className="thumb-label">{formatDuration(item.durationSeconds)}</span> : null}
      </div>
    </div>
  );
}

export function ContentCard({ item }: { item: FeedItem }) {
  const creatorName = item.creator?.name ?? 'Unknown creator';
  return (
    <div className="content-card">
      <Link to={watchPath(item.id)}>
        <Thumbnail item={item} />
      </Link>
      <div className="content-meta">
        {item.creator ? (
          <Link to={creatorPath(item.creator.id)}>
            <Avatar name={creatorName} id={item.creator.id} />
          </Link>
        ) : (
          <div className="avatar" style={{ background: 'var(--bg-elev-2)', color: 'var(--text-faint)' }}>
            <Ban size={16} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <Link to={watchPath(item.id)} className="content-title" title={item.title}>
            {item.title}
          </Link>
          <div className="content-sub">
            {item.creator ? <Link to={creatorPath(item.creator.id)}>{creatorName}</Link> : creatorName}
          </div>
          <div className="content-sub">
            {timeAgo(item.publishedAt)} · via {item.viaName}
          </div>
        </div>
      </div>
    </div>
  );
}
