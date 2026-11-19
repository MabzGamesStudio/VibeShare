// The image-list viewer and the verification gate for image bytes. One file of many
// images (the image-list container) shows ONE image at a time — arrows and the counter
// sit outside the picture — and no image bytes load at all until the algorithm nodes
// vouch for the content.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { parseImageList, type ImageListImage } from '../../../src/shared/image-list';
import { parseContentId } from '../../../src/shared/sources';
import { api, needsResolving, resolveStream, streamUrl } from '../api';

/** Session cache: one `/api/lookup` per content id, shared by every image on screen. */
const verified = new Map<string, Promise<boolean>>();

function lookup(id: string): Promise<boolean> {
  let known = verified.get(id);
  if (!known) {
    known = api<{ known: Record<string, boolean> }>('/api/lookup', { body: { ids: [id] } })
      .then((answer) => Boolean(answer.known[id]))
      .catch(() => false);
    verified.set(id, known);
  }
  return known;
}

/**
 * Whether the algorithm nodes vouch for this content. null while it is being checked —
 * show a placeholder, never the bytes: an image nobody has listed must not load even
 * when its bytes are fetchable.
 */
export function useVerified(id: string | undefined): boolean | null {
  const [state, setState] = useState<boolean | null>(null);
  useEffect(() => {
    if (!id) {
      setState(false);
      return;
    }
    let alive = true;
    setState(null);
    void lookup(id).then((ok) => {
      if (alive) setState(ok);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return state;
}

/** What stands in for an image the algorithm nodes have not verified. */
export function UnverifiedImage() {
  return <span className="image-full image-missing small faint">Not verified by the algorithm node yet</span>;
}

/**
 * One image list: the container's pictures, one at a time — the picture between its
 * two arrows (outside it, never over it) and the "2 / 5" counter below. Clicking the
 * picture or pressing ←/→ scrolls. While the list loads there is a neutral
 * placeholder; a container that cannot be read says so instead of showing anything
 * stale. `variant` sizes the arrows: the watch page and a compact feed card.
 */
export function ImageListView({ id, url, title, variant = 'watch' }: { id?: string; url?: string; title?: string; variant?: 'watch' | 'feed' }) {
  const base = id ? (parseContentId(id)?.base ?? id) : undefined;
  const verified = useVerified(base);
  const [images, setImages] = useState<ImageListImage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [index, setIndex] = useState(0);
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Nothing loads before the algorithm nodes vouch for the content — even when a
    // ready URL was handed in.
    if (verified !== true) return;
    let alive = true;
    setImages(null);
    setFailed(false);
    (async () => {
      try {
        const target = url ?? streamUrl(base!);
        const resolved = needsResolving(target) ? await resolveStream(target) : target;
        const bytes = new Uint8Array(await (await fetch(resolved)).arrayBuffer());
        const parsed = parseImageList(bytes);
        if (!alive) return;
        if (!parsed?.length) setFailed(true);
        else setImages(parsed);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [verified, base, url]);

  const image = images ? images[Math.min(index, Math.max(0, images.length - 1))] : undefined;
  useEffect(() => {
    if (!image) return;
    const blobUrl = URL.createObjectURL(new Blob([image.data.buffer as ArrayBuffer], { type: image.mime }));
    setSrc(blobUrl);
    setLoaded(false);
    return () => URL.revokeObjectURL(blobUrl);
  }, [image]);

  const scroll = useCallback(
    (step: number) => {
      setIndex((at) => (images ? (at + step + images.length) % images.length : 0));
    },
    [images]
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') scroll(-1);
      if (event.key === 'ArrowRight') scroll(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [scroll]);

  if (verified === false) return <UnverifiedImage />;
  if (failed) return <span className="image-full image-missing small faint">This image list could not be read.</span>;
  if (!images || !image) return <span className="image-skeleton" />;
  return (
    <div className={`image-list-view ${variant === 'feed' ? 'compact' : ''}`}>
      <div className="image-list-row">
        <button type="button" className="round icon image-list-nav" aria-label="Previous image" onClick={() => scroll(-1)}>
          <ChevronLeft size={18} />
        </button>
        <button type="button" className="image-frame" onClick={() => scroll(1)} aria-label={`${title ?? image.name} — click for the next image`}>
          {!loaded && <span className="image-skeleton" />}
          {src && (
            <img
              className="image-full"
              src={src}
              alt={image.name || title || 'Image'}
              style={{ opacity: loaded ? 1 : 0 }}
              onLoad={() => setLoaded(true)}
              onError={() => setLoaded(true)}
            />
          )}
        </button>
        <button type="button" className="round icon image-list-nav" aria-label="Next image" onClick={() => scroll(1)}>
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="image-list-counter tiny">{`${Math.min(index, images.length - 1) + 1} / ${images.length}`}</div>
    </div>
  );
}
