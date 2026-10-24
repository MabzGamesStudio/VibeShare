import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ClientState, NodeEntry, Settings } from '../../src/shared/clientapi';
import { useLocation } from 'react-router-dom';
import { api, errorMessage, onNodesChanged } from './api';
import { setBlockExternalEmbeds } from './media';
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

  const refresh = useCallback(async () => {
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

  // No polling: the state is re-read from the client (never from nodes) when the user
  // moves to another page or comes back to the window.
  const location = useLocation();
  useEffect(() => {
    void refresh();
  }, [refresh, location.pathname]);
  // Credits and node status arrive live from the client as answers from nodes change them.
  useEffect(() => onNodesChanged((nodes) => setState((current) => (current ? { ...current, nodes } : current))), []);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

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
