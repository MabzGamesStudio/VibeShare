// Every successful publishing path records its content id in one predictable collection.
// This is per profile, like the rest of the saved-cid state, and preserves any collections
// the user already assigned to that id.
import { emptySavedState, type ClientStoreLike } from './model.js';

export const PUBLISHED_COLLECTION = 'Published Content';

export function rememberPublished(store: ClientStoreLike, id: string, title?: string): void {
  if (!id) return;
  const saved = (store.data.data.saved ??= emptySavedState());
  saved.collections ??= [];
  saved.items ??= [];
  let collection = saved.collections.find((entry) => entry.name.toLowerCase() === PUBLISHED_COLLECTION.toLowerCase());
  if (!collection) {
    collection = {
      id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: PUBLISHED_COLLECTION,
      addedAt: new Date().toISOString(),
    };
    saved.collections.push(collection);
  }
  const existing = saved.items.find((item) => item.id === id);
  if (existing) {
    if (title?.trim()) existing.title = title.trim().slice(0, 300);
    if (!existing.collections.includes(collection.id)) existing.collections.push(collection.id);
  } else {
    saved.items.unshift({
      id,
      title: title?.trim().slice(0, 300) || id,
      addedAt: new Date().toISOString(),
      collections: [collection.id],
    });
  }
  store.changed();
}
