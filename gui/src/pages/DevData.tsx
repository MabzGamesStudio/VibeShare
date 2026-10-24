// Developer builds only: the local static data host page. Upload a file to a provider by
// its content id, offer that URL (or the base URL) as a downloadable copy of the cid, and
// pull it — the whole URL → credits round trip on one machine. Production builds hide it.
import { useCallback, useEffect, useState } from 'react';
import { bytesCid } from '../../../src/shared/content.js';
import { base64url } from '../../../src/shared/encoding.js';
import { api, errorMessage } from '../api';
import { useApp } from '../state';
import { formatBytes } from '../util';

export function DevDataPage() {
  const { state } = useApp();
  const providers = state?.nodes.filter((node) => node.type === 'provider' && node.enabled) ?? [];
  const [provider, setProvider] = useState('');
  const [dev, setDev] = useState<boolean | null>(null);
  const [files, setFiles] = useState<{ cid: string; size: number }[] | null>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chosenNode = providers.find((node) => node.id === (provider || providers[0]?.id));

  const load = useCallback(() => {
    if (!chosenNode) return;
    api<{ files: { cid: string; size: number }[] }>(`/api/nodes/${chosenNode.id}/dev-host`)
      .then((answer) => setFiles(answer.files))
      .catch((e) => setNote(errorMessage(e)));
  }, [chosenNode?.id]);
  useEffect(() => {
    api<{ dev: boolean }>('/api/dev/info')
      .then((answer) => setDev(answer.dev))
      .catch(() => setDev(false));
  }, []);
  useEffect(load, [load]);

  if (dev === false) {
    return (
      <div className="page">
        <h1>Dev data</h1>
        <div className="banner warn">This page is for developer builds only — it is not part of production.</div>
      </div>
    );
  }

  const act = async (text: string, run: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await run();
      setNote(text);
    } catch (e) {
      setNote(errorMessage(e));
    }
    setBusy(false);
    load();
  };

  const upload = () =>
    void act('Uploaded by content id', async () => {
      if (!picked || !chosenNode) return;
      const bytes = new Uint8Array(await picked.arrayBuffer());
      await api(`/api/nodes/${chosenNode.id}/dev-host`, { body: { cid: bytesCid(bytes), data: base64url(bytes) } });
      setPicked(null);
    });

  return (
    <div className="page">
      <h1>Dev data</h1>
      <p className="small muted">
        Developer builds only. Files uploaded here are served by the provider at <code>{chosenNode?.url ?? '…'}/v1/dev/host/&lt;cid&gt;</code> and at the
        base shape <code>…/v1/dev/host/base/&lt;cid&gt;</code>, so a full URL or a base URL can be offered as a downloadable copy and fetched — the provider
        pays your account for every download whose bytes hash to the cid exactly.
      </p>
      {note && <div className="banner info small">{note}</div>}
      <div className="card form-stack">
        <div className="form-grid">
          <label className="field">
            Provider
            <select value={chosenNode?.id ?? ''} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            File
            <input type="file" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <div className="row">
          <button className="primary" disabled={!picked || !chosenNode || busy} onClick={upload}>
            Upload by content id
          </button>
          <button
            disabled={!chosenNode || busy}
            onClick={() =>
              void act('Offered the base URL — the provider queries it for any cid', () =>
                api(`/api/nodes/${chosenNode!.id}/content-urls`, { body: { items: [{ baseUrl: `${chosenNode!.url}/v1/dev/host/base` }] } })
              )
            }
          >
            Offer base URL
          </button>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Content id</th>
              <th>Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(files ?? []).map((file) => (
              <tr key={file.cid}>
                <td className="mono tiny" title={file.cid}>
                  {file.cid.slice(0, 28)}…
                </td>
                <td className="small">{formatBytes(file.size)}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    <button
                      className="small"
                      disabled={!chosenNode || busy}
                      onClick={() =>
                        void act('Offered the full URL for this cid', () =>
                          api(`/api/nodes/${chosenNode!.id}/content-urls`, {
                            body: { items: [{ cid: file.cid, url: `${chosenNode!.url}/v1/dev/host/${file.cid}` }] },
                          })
                        )
                      }
                    >
                      Offer URL
                    </button>
                    <button
                      className="small"
                      disabled={!chosenNode || busy}
                      onClick={() =>
                        void act('Fetched the copy — the download credits are on your account', () =>
                          api(`/api/nodes/${chosenNode!.id}/content-urls/fetch`, { body: { cid: file.cid } })
                        )
                      }
                    >
                      Fetch (earns credits)
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}