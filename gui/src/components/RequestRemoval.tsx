// Asking the nodes to remove or hide one content: which nodes, and why (optionally).
// The library's row action and the content page's "About this content" dialog share
// this form, so the two can never drift apart.
import { useState } from 'react';
import { api, errorMessage } from '../api';
import { useApp } from '../state';
import { Modal } from './ui';

export interface RemovalTarget {
  id: string;
  title?: string;
}

interface RemovalResult {
  node: string;
  name: string;
  ok: boolean;
  error?: string;
}

function useRemoval(target: RemovalTarget) {
  const { state, toast } = useApp();
  const nodes = state?.nodes ?? [];
  const [chosen, setChosen] = useState<string[]>(() => nodes.filter((node) => node.enabled).map((node) => node.id));
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<RemovalResult[] | null>(null);

  const send = async () => {
    setSending(true);
    try {
      const answer = await api<{ results: RemovalResult[] }>('/api/removals', {
        method: 'POST',
        body: { nodeIds: chosen, id: target.id, message: message.trim() || undefined },
      });
      setResults(answer.results);
      const sent = answer.results.filter((result) => result.ok).length;
      toast(`Removal requested on ${sent} of ${answer.results.length} nodes`, sent ? 'success' : 'error');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSending(false);
    }
  };

  return { nodes, chosen, setChosen, message, setMessage, sending, results, send };
}

type RemovalRequest = ReturnType<typeof useRemoval>;

/** The form itself: the words, the nodes to ask, the message, and what came back. */
function RemovalForm({ target, request }: { target: RemovalTarget; request: RemovalRequest }) {
  const { nodes, chosen, setChosen, message, setMessage, results } = request;
  return (
    <div className="form-stack">
      <p className="small muted">
        This asks the nodes you pick to remove or hide{target.title ? <> <strong>{target.title}</strong></> : ''}. Each node decides for
        itself — the request goes out on your account on it, and only the nodes that can delete or hide the content will.
      </p>
      <div className="field">
        Nodes to ask
        {nodes.map((node) => (
          <label key={node.id} className="row small" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={chosen.includes(node.id)}
              onChange={(e) => setChosen((current) => (e.target.checked ? [...current, node.id] : current.filter((entry) => entry !== node.id)))}
            />
            {node.name} <span className="faint">· {node.type}</span>
          </label>
        ))}
        {!nodes.length && <span className="hint">No nodes are configured yet.</span>}
      </div>
      <label className="field">
        Message <span className="hint">(optional)</span>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Why this content should be removed" />
      </label>
      {results && (
        <div className="field">
          Results
          {results.map((result) => (
            <div key={result.node} className="row small" style={{ gap: 8 }}>
              {result.ok ? <span className="badge ok">sent</span> : <span className="badge danger">failed</span>}
              <span>{result.name}</span>
              {result.error && <span className="faint">{result.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The buttons: Cancel/Send before it goes out, Close once it has (nothing to close inline). */
function RemovalActions({ request, onClose }: { request: RemovalRequest; onClose?: () => void }) {
  const { results, sending, chosen, send } = request;
  if (results) {
    return onClose ? (
      <button className="primary" onClick={onClose}>
        Close
      </button>
    ) : null;
  }
  return (
    <>
      {onClose && <button onClick={onClose}>Cancel</button>}
      <button className="primary" disabled={sending || chosen.length === 0} onClick={() => void send()}>
        {sending ? 'Sending…' : 'Send request'}
      </button>
    </>
  );
}

/** The form inline (inside another dialog already): fields and the Send button together. */
export function RequestRemoval({ target }: { target: RemovalTarget }) {
  const request = useRemoval(target);
  return (
    <div className="form-stack">
      <RemovalForm target={target} request={request} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <RemovalActions request={request} />
      </div>
    </div>
  );
}

/** The library's own dialog: the same form, wrapped in a modal with its buttons below. */
export function RemovalModal({ target, onClose }: { target: { id: string; title: string }; onClose: () => void }) {
  const request = useRemoval(target);
  return (
    <Modal
      title="Request content removal"
      onClose={onClose}
      actions={<RemovalActions request={request} onClose={onClose} />}
    >
      <RemovalForm target={target} request={request} />
    </Modal>
  );
}

export type { RemovalResult };
