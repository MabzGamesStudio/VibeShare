// The web client's service worker: it runs the client backend for every tab of the
// client, answering /api/… and /stream/… (with Range requests, so videos play and
// seek while chunks are fetched and verified). Built as a classic script (sw.js).
import './polyfill';
import { createBackend, type Backend } from './backend';
import { loadConfig } from './config';
import { openIndexedDb } from './store';

// The few service worker types used here (the DOM library does not have them).
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface MessageEvent extends ExtendableEvent {
  data: unknown;
}
interface Worker {
  registration: { scope: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
const worker = self as unknown as Worker;

let backend: Promise<Backend> | null = null;

function getBackend(): Promise<Backend> {
  backend ??= (async () => {
    const scope = new URL(worker.registration.scope);
    const config = await loadConfig(scope.href);
    return createBackend({ kv: await openIndexedDb(), config, appUrl: scope.href, hostName: scope.hostname });
  })().catch((error) => {
    backend = null;
    throw error;
  });
  return backend;
}

worker.addEventListener('install', (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener('activate', (event) => event.waitUntil(worker.clients.claim()));
// A page loaded without the worker (a hard reload) asks to be taken over.
worker.addEventListener('message', (event) => {
  if (event.data === 'claim') event.waitUntil(worker.clients.claim());
});

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(worker.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = `/${url.pathname.slice(scope.pathname.length)}`;
  if (!path.startsWith('/api/') && !path.startsWith('/stream/')) return;
  event.respondWith(
    (async () => {
      const ready = await getBackend();
      const response = await ready.handle(event.request, path);
      // Saving and publishing finish even if every tab closes.
      event.waitUntil(ready.idle());
      return response;
    })().catch(
      (error) =>
        new Response(JSON.stringify({ error: { code: 'internal', message: String((error as Error)?.message ?? error) } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
    )
  );
});
