import { useState } from 'react';
import type { FeedItem, PageConfig } from '../../../../src/shared/clientapi';
import { usePreviewSeen } from '../../bloom';
import { PostDownload } from '../Download';
import { SaveCidButton } from '../SaveCid';
import { aspectOf, playableFor } from '../../media';
import { ShareButton } from '../Share';
import { Fields } from './Fields';
import { FeedImage, ImageLightbox } from './ImageFeed';
import { MediaView } from './Player';
import { formatDuration } from '../../util';
import { useInView } from './usePaged';

function StreamPost({
  item,
  page,
  ipfsGateway,
  onOpenImage,
}: {
  item: FeedItem;
  page: PageConfig;
  ipfsGateway: string;
  onOpenImage: (item: FeedItem) => void;
}) {
  const [ref, inView] = useInView<HTMLDivElement>(0.5);
  const seen = usePreviewSeen(item);
  const [started, setStarted] = useState(false);
  const kind = playableFor(item).kind;
  const image = kind === 'image' || (item.format === 'image' && kind !== 'iframe');
  const aspect = aspectOf(item) ?? (image ? undefined : 16 / 9);

  return (
    // An image post is plain around the picture: no rounded corners to cut it with.
    <article className={`post ${image ? 'post-plain' : ''}`} ref={seen}>
      {image ? (
        <FeedImage item={item} onOpen={() => onOpenImage(item)} />
      ) : (
        <div className="post-media" ref={ref} style={aspect ? { aspectRatio: String(aspect) } : undefined}>
          {!started && item.durationSeconds ? (
            <span className="thumb-overlay">
              <span className="thumb-label">{formatDuration(item.durationSeconds)}</span>
            </span>
          ) : null}
          <MediaView
            item={item}
            active={inView && (started || (page.options.autoplay && kind !== 'iframe'))}
            muted={page.options.muted}
            controls
            fit="contain"
            ipfsGateway={ipfsGateway}
            onActivate={() => setStarted(true)}
          />
        </div>
      )}
      <div className="post-footer">
        <Fields item={item} fields={page.fields} variant="card" />
        <div className="row">
          <SaveCidButton id={item.id} title={item.title} className="ghost icon" compact />
          <PostDownload item={item} className="ghost icon" />
          <ShareButton target={{ id: item.id, title: item.title }} />
        </div>
      </div>
    </article>
  );
}

/** One column of posts, loading more as you scroll: the image feed. */
export function StreamLayout({ items, page, ipfsGateway }: { items: FeedItem[]; page: PageConfig; ipfsGateway: string }) {
  const [open, setOpen] = useState<FeedItem | null>(null);
  return (
    <div className={`stream stream-${page.options.size} ${items.some((item) => item.format === 'image') ? 'stream-images' : ''}`}>
      {items.map((item) => (
        <StreamPost key={item.id} item={item} page={page} ipfsGateway={ipfsGateway} onOpenImage={setOpen} />
      ))}
      {open && <ImageLightbox item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
