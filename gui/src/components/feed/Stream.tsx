import { MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { DEFAULT_SHORT_BUTTONS, type FeedItem, type PageConfig, type ShortButton } from '../../../../src/shared/clientapi';
import { usePreviewSeen } from '../../bloom';
import { Comments } from '../Comments';
import { PostDownload } from '../Download';
import { SaveCidButton } from '../SaveCid';
import { aspectOf, playableFor } from '../../media';
import { ShareButton } from '../Share';
import { Fields } from './Fields';
import { FeedImage, ImageLightbox } from './ImageFeed';
import { MediaView } from './Player';
import { VoteButton } from './Shorts';
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
  onOpenImage: (item: FeedItem, src?: string) => void;
}) {
  const [ref, inView] = useInView<HTMLDivElement>(0.5);
  const seen = usePreviewSeen(item);
  const [started, setStarted] = useState(false);
  const kind = playableFor(item).kind;
  const image = kind === 'image' || ((item.format === 'image' || item.format === 'image-list') && kind !== 'iframe');
  const aspect = aspectOf(item) ?? (image ? undefined : 16 / 9);

  return (
    // An image post is plain around the picture: no rounded corners to cut it with.
    <article className={`post ${image ? 'post-plain' : ''}`} ref={seen}>
      {image ? (
        <ImagePost item={item} page={page} onOpenImage={onOpenImage} />
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

/**
 * An image post: the picture (or the image list), the like/dislike/comment/share rail —
 * hidden behind the fullscreen view — and the same comments section as the shorts.
 */
function ImagePost({ item, page, onOpenImage }: { item: FeedItem; page: PageConfig; onOpenImage: (item: FeedItem, src?: string) => void }) {
  const [comments, setComments] = useState(false);
  const shown = new Set<ShortButton>(page.options.shortButtons ?? DEFAULT_SHORT_BUTTONS);
  const mode = page.options.shortsComments === 'shrink' ? 'shrink' : 'cover';
  const share = Math.min(90, Math.max(10, Number(page.options.shortsCommentsSize) || 50));
  return (
    <div
      className={`image-stage ${comments ? `comments-${mode}` : ''}`}
      style={comments ? ({ '--comments-share': `${share}%` } as React.CSSProperties) : undefined}
      onClick={(event) => {
        // With the comments open, a click anywhere outside of them closes the section.
        if (comments && !(event.target as HTMLElement).closest('.short-comments')) setComments(false);
      }}
    >
      <div className="image-media">
        <FeedImage item={item} onOpen={(src) => onOpenImage(item, src)} />
        <div className="image-rail">
          {shown.has('like') && <VoteButton item={item} value={1} />}
          {shown.has('dislike') && <VoteButton item={item} value={-1} />}
          {shown.has('comments') && (
            <button
              type="button"
              className={`rail-button ${comments ? 'on' : ''}`}
              aria-pressed={comments}
              aria-label="Comments"
              onClick={() => setComments((open) => !open)}
            >
              <MessageCircle size={18} />
              <span>Comments</span>
            </button>
          )}
          {shown.has('share') && <ShareButton target={{ id: item.id, title: item.title }} className="rail-button" label="Share" />}
        </div>
      </div>
      {comments && (
        <div className="short-comments">
          <Comments contentId={item.contentId ?? item.id} />
        </div>
      )}
    </div>
  );
}

/** One column of posts, loading more as you scroll: the image feed. */
export function StreamLayout({ items, page, ipfsGateway }: { items: FeedItem[]; page: PageConfig; ipfsGateway: string }) {
  const [open, setOpen] = useState<{ item: FeedItem; src?: string } | null>(null);
  return (
    <div className={`stream stream-${page.options.size} ${items.some((item) => item.format === 'image') ? 'stream-images' : ''}`}>
      {items.map((item) => (
        <StreamPost key={item.id} item={item} page={page} ipfsGateway={ipfsGateway} onOpenImage={(item, src) => setOpen({ item, src })} />
      ))}
      {open && <ImageLightbox item={open.item} src={open.src} onClose={() => setOpen(null)} />}
    </div>
  );
}
