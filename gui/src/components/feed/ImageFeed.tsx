// The image feed: full-resolution pictures, a skeleton until each is in, every frame one
// height (the picture keeps its own ratio inside it and is never cut — corners included),
// and a click opens it fullscreen right there, so the feed keeps its place behind it.
import { useEffect, useState } from 'react';
import type { FeedItem } from '../../../../src/shared/clientapi';
import { imageFor, useMediaSrc } from '../../media';

/** One image filling the screen: click outside or press Escape to come back. */
export function ImageLightbox({ item, onClose }: { item: FeedItem; onClose: () => void }) {
  const image = useMediaSrc(imageFor(item));
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
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <button type="button" className="image-lightbox-close" onClick={onClose} aria-label="Close">
        ×
      </button>
    </div>
  );
}

/** One feed image: the full-resolution picture from the start, skeleton until it loads. */
export function FeedImage({ item, onOpen }: { item: FeedItem; onOpen: () => void }) {
  const image = useMediaSrc(imageFor(item));
  const [loaded, setLoaded] = useState(false);
  return (
    <button type="button" className="image-frame" onClick={onOpen} aria-label={`View ${item.title} fullscreen`}>
      {!loaded && <span className="image-skeleton" />}
      {image ? (
        <img
          className="image-full"
          src={image}
          alt={item.title}
          loading="lazy"
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
        />
      ) : (
        <span className="image-full image-missing small faint">{item.title}</span>
      )}
    </button>
  );
}