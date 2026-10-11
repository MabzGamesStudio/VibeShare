import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { NodeEntry } from '../../../src/shared/clientapi';
import { api, errorMessage } from '../api';
import { useApp } from '../state';
import { Spinner } from './ui';

/** Paste one or more node references (or plain URLs) to add them. */
export function AddNodes({ compact }: { compact?: boolean }) {
  const { refresh, toast } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ ref: string; error: string }[]>([]);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const result = await api<{ added: NodeEntry[]; errors: { ref: string; error: string }[] }>('/api/nodes', { body: { text } });
      setErrors(result.errors);
      if (result.added.length) {
        toast(`Added ${result.added.map((n) => n.name).join(', ')}`, 'success');
        setText(result.errors.map((e) => e.ref).join('\n'));
      }
      await refresh();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-stack">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'vs:provider:vk1…@https://cdn.example.org\nvs:algorithm:vk1…@https://feed.example.org\nhttps://another-node.example.net'}
        rows={compact ? 3 : 4}
        className="mono"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add();
        }}
      />
      <div className="row">
        <button className="primary" onClick={add} disabled={busy || !text.trim()}>
          {busy ? <Spinner /> : <Plus size={16} />} Add nodes
        </button>
        <span className="hint">One reference per line. The node's type and key are checked before it is added.</span>
      </div>
      {errors.length > 0 && (
        <div className="banner danger small">
          <div>
            {errors.map((error) => (
              <div key={error.ref}>
                <code>{error.ref.length > 60 ? error.ref.slice(0, 60) + '…' : error.ref}</code>: {error.error}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
