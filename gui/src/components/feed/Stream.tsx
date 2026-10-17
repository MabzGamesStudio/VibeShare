import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FeedItem, PageConfig } from '../../../../src/shared/clientapi';
import { usePreviewSeen } from '../../bloom';
import { aspectOf, imageFor, playableFor } from '../../media';
import { watchPath } from '../../util';
import { ShareButton } from '../Share';
import { Fields } from './Fields';
import { MediaView, Poster } from './Player';
import { useInView } from './usePaged';

function StreamPost({ item, page, ipfsGateway }: { item: FeedItem; page: PageConfig; ipfsGateway: string }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.5);
  const seen = usePreviewSeen(item);
  const [started, setStarted] = useState(false);
  const kind = playableFor(item).kind;
  const image = kind === 'image' || (item.format === 'image' && kind !== 'iframe');
  const aspect = aspectOf(item) ?? (image ? undefined : 16 / 9);

  return (
    <article className="post" ref={seen}>
      <div className={`post-media ${image ? 'post-image' : ''}`} ref={ref} style={aspect ? { aspectRatio: String(aspect) } : undefined}>
        {image ? (
          <Link to={watchPath(item.id)} aria-label={item.title}>
            <Poster item={item} src={imageFor(item)} fit="contain" />
          </Link>
        ) : (
          <MediaView
            item={item}
            active={inView && (started || (page.options.autoplay && kind !== 'iframe'))}
            muted={page.options.muted}
            controls
            fit="contain"
            ipfsGateway={ipfsGateway}
            onActivate={() => setStarted(true)}
          />
        )}
      </div>
      <div className="post-footer">
        <Fields item={item} fields={page.fields} variant="card" />
        <ShareButton target={{ id: item.id, title: item.title }} />
      </div>
    </article>
  );
}

/** One column of posts, loading more as you scroll: the image feed. */
export function StreamLayout({ items, page, ipfsGateway }: { items: FeedItem[]; page: PageConfig; ipfsGateway: string }) {
  return (
    <div className={`stream stream-${page.options.size}`}>
      {items.map((item) => (
        <StreamPost key={item.id} item={item} page={page} ipfsGateway={ipfsGateway} />
      ))}
    </div>
  );
}
