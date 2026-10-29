import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ClientState, NodeEntry, Settings } from '../../src/shared/clientapi';
import { useLocation } from 'react-router-dom';
import { api, errorMessage, onNodesChanged } from './api';
import { setBlockExternalEmbeds, setContentPreviews } from './media';
import { embedsAllowed, loadConsent, onConsentChange } from './consent';

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
}

interface AppContext {
  state: ClientState | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** Saves settings; false (after showing why) when the client refused them. */
  updateSettings: (patch: Partial<Settings>) => Promise<boolean>;
  toast: (message: string, kind?: Toast['kind']) => void;
  providers: NodeEntry[];
  algorithms: NodeEntry[];
}

const Context = createContext<AppContext | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ClientState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** When `/api/state` was last read — automatic re-reads are spaced at least this far. */
  const lastRefresh = useRef(0);

  const refresh = useCallback(async () => {
    lastRefresh.current = Date.now();
    try {
      setState(await api<ClientState>('/api/state'));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, message, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      try {
        const settings = await api<Settings>('/api/settings', { method: 'PATCH', body: patch });
        setState((current) => (current ? { ...current, settings } : current));
        return true;
      } catch (e) {
        toast(errorMessage(e), 'error');
        return false;
      }
    },
    [toast]
  );

  // The state is read once when the app opens. After that the GUI re-reads it (always from
  // the client, never from the nodes) only as often as `stateRefreshSeconds` allows — 0,
  // the default, means not at all: credits and node status stay live over the events
  // stream and the app re-reads after its own changes anyway. Only settings, pages or
  // nodes changed elsewhere (another window, the daemon) need the automatic read.
  const location = useLocation();
  const settingsRef = useRef(state?.settings);
  settingsRef.current = state?.settings;
  const maybeRefresh = useCallback(() => {
    const every = (settingsRef.current?.stateRefreshSeconds ?? 0) * 1000;
    if (every <= 0 || Date.now() - lastRefresh.current < every) return;
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    maybeRefresh();
  }, [maybeRefresh, location.pathname]);
  // Credits and node status arrive live from the client as answers from nodes change them.
  useEffect(() => onNodesChanged((nodes) => setState((current) => (current ? { ...current, nodes } : current))), []);
  useEffect(() => {
    const onFocus = () => maybeRefresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [maybeRefresh]);

  useEffect(() => {
    const theme = state?.settings.theme ?? 'system';
    document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
  }, [state?.settings.theme]);

  // External embeds are off until the person allows third-party cookies: both the
  // consent choice and the setting have to say yes before anything from another
  // platform loads, and a consent change applies at once.
  useEffect(() => {
    const apply = () => setBlockExternalEmbeds(Boolean(state?.settings.blockExternalEmbeds) || !embedsAllowed(loadConsent()));
    apply();
    return onConsentChange(apply);
  }, [state?.settings.blockExternalEmbeds]);

  useEffect(() => {
    setContentPreviews(state?.settings.showContentPreviews !== false);
  }, [state?.settings.showContentPreviews]);

  const value = useMemo<AppContext>(
    () => ({
      state,
      error,
      refresh,
      updateSettings,
      toast,
      providers: state?.nodes.filter((node) => node.type === 'provider') ?? [],
      algorithms: state?.nodes.filter((node) => node.type === 'algorithm') ?? [],
    }),
    [state, error, refresh, updateSettings, toast]
  );

  return (
    <Context.Provider value={value}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </Context.Provider>
  );
}

export function useApp(): AppContext {
  const context = useContext(Context);
  if (!context) throw new Error('useApp outside AppProvider');
  return context;
}
