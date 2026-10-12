// Starts the web client's backend: a service worker when the browser has them, the page
// itself otherwise.
export type BackendMode = 'worker' | 'page';

function controllerChange(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true }
    );
  });
}

async function startWorker(): Promise<boolean> {
  await navigator.serviceWorker.register('sw.js', { scope: './' });
  const registration = await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return true;
  // First visit (the worker takes over open pages when it activates) or a hard reload.
  const changed = controllerChange(4000);
  if (navigator.serviceWorker.controller) return true;
  registration.active?.postMessage('claim');
  return changed;
}

export async function startBackend(): Promise<BackendMode> {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try {
      // Browsers that block workers can leave registration pending forever.
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000));
      if (await Promise.race([startWorker(), timeout])) return 'worker';
    } catch (error) {
      console.warn('No service worker; the client runs in the page', error);
    }
  }
  const { startInPage } = await import('./local');
  await startInPage();
  return 'page';
}
