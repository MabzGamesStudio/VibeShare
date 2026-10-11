import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ClientState, NodeEntry, Settings } from '../../src/shared/clientapi';
import { api, errorMessage } from './api';

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
}

interface AppContext {
  state: ClientState | null;
  error: string | null;
  refresh: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
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
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    },
    [toast]
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const theme = state?.settings.theme ?? 'system';
    document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
  }, [state?.settings.theme]);

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
