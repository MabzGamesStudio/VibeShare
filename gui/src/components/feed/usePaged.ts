import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem, FeedResponse } from '../../../../src/shared/clientapi';
import { errorMessage } from '../../api';

export interface Paged {
  items: FeedItem[];
  errors: FeedResponse['errors'];
  loading: boolean;
  done: boolean;
  failure: string | null;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Items of a page, fetched a page at a time. `key` identifies what is being listed:
 * when it changes, everything starts over. Every page after the first waits `pauseMs`
 * first: friction, so racing through a list does not spend credits on unseen content.
 */
export function usePaged(load: (cursor?: string) => Promise<FeedResponse>, key: string, pauseMs = 0): Paged {
  const [items, setItems] = useState<FeedItem[]>([]);
  const itemsRef = useRef<FeedItem[]>([]);
  const [errors, setErrors] = useState<FeedResponse['errors']>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const cursor = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const busy = useRef(false);
  const finished = useRef(false);
  // Pages in a row that brought nothing new: nodes that keep returning a cursor with
  // nothing behind it must not make the page ask forever.
  const empty = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const pause = useRef(pauseMs);
  pause.current = pauseMs;

  const fetchPage = useCallback(async (first: boolean) => {
    if (busy.current && !first) return;
    const mine = first ? ++generation.current : generation.current;
    busy.current = true;
    setLoading(true);
    try {
      const page = await loader.current(first ? undefined : cursor.current);
      if (mine !== generation.current) return;
      cursor.current = page.cursor;
      setErrors(page.errors);
      setFailure(null);
      const known = new Set((first ? [] : itemsRef.current).map((item) => item.id.split('~')[0]));
      const fresh: FeedItem[] = [];
      for (const item of page.items) {
        const base = item.id.split('~')[0];
        if (!known.has(base)) {
          known.add(base);
          fresh.push(item);
        }
      }
      empty.current = fresh.length ? 0 : empty.current + 1;
      finished.current = !page.cursor || empty.current >= 3;
      setDone(finished.current);
      itemsRef.current = first ? fresh : [...itemsRef.current, ...fresh];
      setItems(itemsRef.current);
    } catch (error) {
      if (mine === generation.current) {
        setFailure(errorMessage(error));
        finished.current = true;
        setDone(true);
      }
    } finally {
      if (mine === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    itemsRef.current = [];
    setItems([]);
    setDone(false);
    finished.current = false;
    empty.current = 0;
    cursor.current = undefined;
    void fetchPage(true);
  }, [key, fetchPage]);

  const loadMore = useCallback(() => {
    if (finished.current || busy.current) return;
    if (pause.current <= 0) return void fetchPage(false);
    busy.current = true;
    setLoading(true);
    const mine = generation.current;
    setTimeout(() => {
      if (mine !== generation.current) return;
      busy.current = false;
      void fetchPage(false);
    }, pause.current);
  }, [fetchPage]);
  const reload = useCallback(() => {
    empty.current = 0;
    finished.current = false;
    void fetchPage(true);
  }, [fetchPage]);

  return { items, errors, loading, done, failure, loadMore, reload };
}

/**
 * Calls `onVisible` whenever the returned element scrolls into (or near) view: endless
 * scrolling. Change `version` after each load so a sentinel that is still in view (a
 * short page) asks for more.
 */
export function useSentinel(onVisible: () => void, enabled: boolean, version: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    // Only once the end is (nearly) on screen: nothing is fetched ahead of the reader.
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && callback.current(), {
      rootMargin: '100px 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, version]);
  return ref;
}

/** Whether an element is (mostly) on screen. */
export function useInView<T extends Element>(threshold = 0.6): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => setVisible(entries[entries.length - 1].isIntersecting), { threshold });
    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold]);
  return [ref, visible];
}
