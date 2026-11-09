import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AppProvider } from './state';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

/**
 * The folder the client is served from ('/' at the root): every route is relative to it,
 * so the same build works at a domain root and in any folder of a static host. A deep
 * link comes in through the 404 page (the web build), which pins this with a <base> tag;
 * a plain load of the folder is its own base.
 */
const base = new URL('.', document.baseURI).pathname.replace(/(.)\/+$/, '$1');

// Links made before the routes moved off the #hash (`…/#/watch/x`) still open.
const legacy = /^#(\/.*)$/.exec(location.hash);
if (legacy) {
  const suffix = legacy[1].replace(/^\//, '');
  const search = suffix.includes('?') ? '' : location.search;
  history.replaceState(null, '', `${base === '/' ? '' : base}/${suffix}${search}`);
}

function render() {
  root.render(
    <StrictMode>
      <BrowserRouter basename={base}>
        <AppProvider>
          <App />
        </AppProvider>
      </BrowserRouter>
    </StrictMode>
  );
}

if (__VIBESHARE_WEB__) {
  // The web client: normal routes (any static host serves it; 404.html catches deep
  // links), backend in the browser.
  root.render(<div className="boot">Starting VibeShare…</div>);
  import('./web/start')
    .then(({ startBackend }) => startBackend())
    .then(() => render())
    .catch((error: Error) => root.render(<div className="boot">VibeShare could not start: {error.message}</div>));
} else {
  render();
}
