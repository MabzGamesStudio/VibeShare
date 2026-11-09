// The image feed: full-resolution pictures, a skeleton until each is in, every frame one
// height (the picture keeps its own ratio inside it and is never cut — corners included),
// and a click opens it fullscreen right there, so the feed keeps its place behind it.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FeedItem } from '../../../../src/shared/clientapi';
import { imageFor, useMediaSrc } from '../../media';

/** One image filling the screen: click outside or press Escape to come back. */
export function ImageLightbox({ item, src, onClose }: { item: FeedItem; src?: string; onClose: () => void }) {
  const image = useMediaSrc(src ?? imageFor(item));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Hiding the scrollbar keeps the page exactly where it was while the image is open.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);
  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={item.title} onClick={onClose}>
      {!loaded && <span className="image-skeleton" />}
      {image && (
        <img
          className="image-lightbox-img"
          src={image}
          alt={item.title}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
        />
      )}
    </div>
  );
}

/** One picture filling its frame; a click opens it fullscreen. */
function ImageFrame({ src, alt, onOpen }: { src?: string; alt: string; onOpen: (src: string) => void }) {
  const image = useMediaSrc(src);
  const [loaded, setLoaded] = useState(false);
  return (
    <button type="button" className="image-frame" onClick={() => image && onOpen(image)} aria-label={`View ${alt} fullscreen`}>
      {!loaded && <span className="image-skeleton" />}
      {image ? (
        <img
          className="image-full"
          src={image}
          alt={alt}
          loading="lazy"
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
        />
      ) : (
        <span className="image-full image-missing small faint">{alt}</span>
      )}
    </button>
  );
}

/**
 * One feed image — or a list of images for one piece of content, with left and right
 * buttons to scroll through the batch. Clicking opens the picture on screen fullscreen.
 */
export function FeedImage({ item, onOpen }: { item: FeedItem; onOpen: (src: string) => void }) {
  const gallery = item.gallery?.map((media) => media.url).filter(Boolean) ?? [];
  const single = imageFor(item);
  const list = gallery.length ? gallery : single ? [single] : [];
  const [index, setIndex] = useState(0);
  return (
    <div className="image-frame-wrap">
      <ImageFrame src={list[Math.min(index, Math.max(0, list.length - 1))]} alt={item.title} onOpen={onOpen} />
      {list.length > 1 && (
        <div className="image-arrows">
          <button type="button" className="round icon" aria-label="Previous image" onClick={() => setIndex((at) => (at - 1 + list.length) % list.length)}>
            <ChevronLeft size={18} />
          </button>
          <span className="tiny">{`${index + 1} / ${list.length}`}</span>
          <button type="button" className="round icon" aria-label="Next image" onClick={() => setIndex((at) => (at + 1) % list.length)}>
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}