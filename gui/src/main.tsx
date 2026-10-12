import { StrictMode, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { App } from './App';
import { AppProvider } from './state';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

function render(Router: ComponentType<{ children?: ReactNode }>) {
  root.render(
    <StrictMode>
      <Router>
        <AppProvider>
          <App />
        </AppProvider>
      </Router>
    </StrictMode>
  );
}

if (__VIBESHARE_WEB__) {
  // The web client: hash routes (any static host serves it), backend in the browser.
  root.render(<div className="boot">Starting VibeShare…</div>);
  import('./web/start')
    .then(({ startBackend }) => startBackend())
    .then(() => render(HashRouter))
    .catch((error: Error) => root.render(<div className="boot">VibeShare could not start: {error.message}</div>));
} else {
  render(BrowserRouter);
}
