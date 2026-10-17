// Seen-content bloom filters in the GUI: previews that come on screen are reported to the
// client, which records the content (its cid and each link, independently) in the filters
// of what the user has seen — the local ones and the copy sent to search algorithm nodes.
import { useEffect, type RefObject } from 'react';
import type { FeedItem } from '../../src/shared/clientapi';
import { api } from './api';
import { useInView } from './components/feed/usePaged';
import { useApp } from './state';

/** Ids already reported in this session (the client drops repeats anyway). */
const reported = new Set<string>();

/** True while any filter that records previews is on. */
export function useTrackingPreviews(): boolean {
  const { state } = useApp();
  return Boolean(state?.settings.previewBloom.enabled || state?.settings.nodeBloom.enabled);
}

/** Reports one shown preview to the client (once per content and session). */
export function markPreviewed(item: Pick<FeedItem, 'id' | 'contentId' | 'link'>, tracking = true): void {
  if (!tracking) return;
  const base = item.id.split('~')[0];
  if (reported.has(base)) return;
  reported.add(base);
  void api('/api/bloom/mark', { body: { scope: 'preview', id: item.id, contentId: item.contentId, link: item.link } }).catch(() => {
    reported.delete(base);
  });
}

/**
 * Attaches to the element holding a content's preview: when the preview scrolls on
 * screen (and the user has therefore seen it), the client records the content as seen.
 */
export function usePreviewSeen(item: FeedItem): RefObject<HTMLDivElement | null> {
  const tracking = useTrackingPreviews();
  const [ref, visible] = useInView<HTMLDivElement>(0.6);
  useEffect(() => {
    if (visible) markPreviewed(item, tracking);
  }, [visible, tracking, item.id]);
  return ref;
}
