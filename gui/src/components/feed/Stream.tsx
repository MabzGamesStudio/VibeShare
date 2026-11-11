import { MessageCircle } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_SHORT_BUTTONS, type FeedItem, type PageConfig, type ShortButton } from '../../../../src/shared/clientapi';
import { usePreviewSeen } from '../../bloom';
import { Comments, useCommentsResize, useScrollLock } from '../Comments';
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
  // Pictures shrink under their comments unless the page says to cover them (shorts are
  // the other way around).
  const mode = page.options.shortsComments === 'cover' ? 'cover' : 'shrink';
  const share = Math.min(90, Math.max(10, Number(page.options.shortsCommentsSize) || 50));
  const panel = useCommentsResize(() => setComments(false));
  useScrollLock(comments);
  const stage = useRef<HTMLDivElement | null>(null);
  // Focused on its comments: the picture locks with its top at the top of the screen (just
  // under the sticky top bar) and fills what is left of the window — so the comments share
  // is a share of the screen, and the mode decides where the picture's bottom lands.
  const [focused, setFocused] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const box = stage.current;
    if (!comments || !box) {
      setFocused(undefined);
      return;
    }
    const fit = () => {
      const topbar = document.querySelector('.topbar');
      const inset = topbar && getComputedStyle(topbar).position === 'sticky' ? topbar.getBoundingClientRect().height : 0;
      setFocused(Math.max(240, window.innerHeight - inset));
      window.scrollTo({ top: Math.max(0, window.scrollY + box.getBoundingClientRect().top - inset) });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [comments]);
  return (
    <div
      ref={stage}
      className={`image-stage ${comments ? `comments-${mode}` : ''}`}
      style={comments ? ({ '--comments-share': panel.share(share), height: focused } as React.CSSProperties) : undefined}
      onClickCapture={(event) => {
        // Clicks in the comments panel are its own business; a click on the picture while
        // the panel is open closes it and stops there — without also opening the
        // fullscreen view underneath.
        if ((event.target as HTMLElement).closest('.short-comments')) return;
        if (comments) {
          event.stopPropagation();
          setComments(false);
        }
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
          <div className="comments-handle" role="separator" aria-label="Resize comments" {...panel.handle} />
          <div className="comments-scroll">
            <Comments contentId={item.contentId ?? item.id} />
          </div>
        </div>
      )}
    </div>
  );
}

/** One column of posts, loading more as you scroll: the image feed. */
export function StreamLayout({ items, page, ipfsGateway }: { items: FeedItem[]; page: PageConfig; ipfsGateway: string }) {
  const [open, setOpen] = useState<{ item: FeedItem; src?: string } | null>(null);
  // The tallest each picture gets, as a share of the screen height (10–100 percent).
  const height = Math.min(100, Math.max(10, Number(page.options.imageHeight) || 72));
  return (
    <div
      className={`stream stream-${page.options.size} ${items.some((item) => item.format === 'image') ? 'stream-images' : ''}`}
      style={{ '--image-height': `${height}vh` } as React.CSSProperties}
    >
      {items.map((item) => (
        <StreamPost key={item.id} item={item} page={page} ipfsGateway={ipfsGateway} onOpenImage={(item, src) => setOpen({ item, src })} />
      ))}
      {open && <ImageLightbox item={open.item} src={open.src} onClose={() => setOpen(null)} />}
    </div>
  );
}
