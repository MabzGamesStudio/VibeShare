// VibeShare desktop: runs the client node inside the app and shows its GUI in a window.
import { app, BrowserWindow, Menu, session, shell, Tray, nativeImage } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let client = null;
let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();

/**
 * With Tor on for every node, the window goes through Tor too (players and pictures from
 * other platforms). It fails closed: when Tor is not running, those do not load at all.
 */
let torRule = null;
async function applyTor(node, settings) {
  let rule = 'direct';
  if (settings.tor?.mode === 'all') {
    let address = { host: '127.0.0.1', port: 9050 };
    try {
      address = await node.tor.proxy.address();
    } catch {
      // not running: keep the usual address, so nothing leaks around it
    }
    rule = `socks5://${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`;
  }
  if (rule === torRule) return;
  torRule = rule;
  await session.defaultSession.setProxy(rule === 'direct' ? { mode: 'direct' } : { proxyRules: rule, proxyBypassRules: '<local>' });
}

async function startClient() {
  const { ClientNode } = await import('./core/client/daemon.js');
  const dataDir = join(app.getPath('userData'), 'client');
  const guiDir = join(here, 'gui');
  // Prefer the usual port so bookmarks keep working; fall back to any free port.
  for (const port of [7700, 0]) {
    const node = new ClientNode({ dataDir, port, guiDir, onSettings: (settings) => void applyTor(node, settings) });
    try {
      await node.start();
      return node;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || port === 0) throw error;
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 380,
    minHeight: 500,
    show: false,
    backgroundColor: '#0d0f14',
    title: 'VibeShare',
    icon: join(here, 'build', 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  const local = client.url();
  // Links to other sites (embeds' originals, checkout pages, docs) open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(local)) {
      event.preventDefault();
      if (/^(https?|bitcoin|ethereum|solana|lightning):/.test(url)) void shell.openExternal(url);
    }
  });
  win.on('close', (event) => {
    // Keep running in the tray while the storage service is on, so it keeps earning.
    if (!quitting && client?.settings.storageService.enabled && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  void win.loadURL(local);
}

function createTray() {
  const icon = nativeImage.createFromPath(join(here, 'build', 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('VibeShare');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open VibeShare', click: () => (win ? win.show() : createWindow()) },
      { label: 'Open in browser', click: () => void shell.openExternal(client.url()) },
      { type: 'separator' },
      { label: 'Quit', click: () => ((quitting = true), app.quit()) },
    ])
  );
  tray.on('click', () => (win ? win.show() : createWindow()));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  try {
    client = await startClient();
  } catch (error) {
    console.error('VibeShare could not start:', error);
    app.quit();
    return;
  }
  try {
    createTray();
  } catch {
    tray = null;
  }
  createWindow();
  app.on('activate', () => (win ? win.show() : createWindow()));
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', (event) => {
  if (client) {
    event.preventDefault();
    const stopping = client;
    client = null;
    stopping.stop().finally(() => app.exit(0));
  }
});
