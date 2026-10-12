// Without a service worker (some private windows, plain http), the backend runs in
// the page itself. Native content then plays from blob URLs instead of streaming.
import './polyfill';
import { setLocalHandler, setStreamResolver } from '../api';
import { createBackend } from './backend';
import { loadConfig } from './config';
import { memoryKeyValue, openIndexedDb } from './store';

export async function startInPage(): Promise<void> {
  const base = new URL('./', location.href);
  const config = await loadConfig(base.href);
  const kv = await openIndexedDb().catch(() => memoryKeyValue());
  const backend = await createBackend({ kv, config, appUrl: base.href, hostName: location.hostname });
  const pathOf = (url: string) => `/${new URL(url).pathname.slice(base.pathname.length)}`;
  setLocalHandler((request) => backend.handle(request, pathOf(request.url)));
  // Media elements cannot use the handler: whole files are fetched into blob URLs.
  const blobs = new Map<string, Promise<string>>();
  setStreamResolver((src) => {
    // One blob per content (playing and downloading share it; the download name comes from the link).
    const key = src.split('?')[0];
    let url = blobs.get(key);
    if (!url) {
      const target = new URL(key, base);
      url = backend.handle(new Request(target), pathOf(target.href)).then(async (response) => {
        if (!response.ok) throw new Error(`Could not load ${key}`);
        return URL.createObjectURL(await response.blob());
      });
      url.catch(() => blobs.delete(key));
      blobs.set(key, url);
    }
    return url;
  });
}
