// TEMPORARY — a page to open and parse a .vvsh file for testing: its metadata, the merkle
// tree (fetched and verified node by node from the root) and every chunk with its bitrate
// leaves and I/P/B frame counts. Not part of the product; it comes out again once the
// format settles.
import { useCallback, useRef, useState } from 'react';
import { useApp } from '../state';
import { api, errorMessage } from '../api';
import { fromBase64url } from '../../../src/shared/encoding.js';
import { parseVvshFile, parseVvshNode, vvshFileJson, type VvshFile, type VvshNode } from '../../../src/shared/vvsh.js';
import { decodeVvshChunk, decodeVvshFrames } from '../../../src/shared/vvsh-encode.js';

type Walked = { hash: string; node: VvshNode | null; children: Walked[] };

async function walk(nodeId: string, hash: string, depth: number, seen: Set<string>): Promise<Walked> {
  if (seen.has(hash) || depth > 24) return { hash, node: null, children: [] };
  seen.add(hash);
  let node: VvshNode | null = null;
  try {
    const bytes = fromBase64url((await api<{ data: string }>('/api/vvsh/object', { body: { nodeId, hash } })).data);
    node = parseVvshNode(bytes, hash);
    if (!node) return { hash, node: null, children: [] };
    const children: Walked[] = [];
    if (node.kind === 'branch') {
      for (const side of [node.left, node.right]) children.push(await walk(nodeId, side, depth + 1, seen));
    } else {
      for (const rendition of node.renditions) children.push({ hash: rendition.hash, node, children: [] });
    }
    return { hash, node, children };
  } catch {
    return { hash, node: null, children: [] };
  }
}

function Tree({ walked, depth = 0 }: { walked: Walked; depth?: number }) {
  const label = walked.node?.kind === 'branch' ? 'branch' : walked.node ? `chunk ${walked.node.index}` : 'unverified';
  return (
    <div style={{ marginLeft: depth ? 16 : 0, fontFamily: 'monospace', fontSize: 12 }}>
      <div>
        <strong>{label}</strong> <span className="faint">{walked.hash.slice(0, 22)}…</span>
        {walked.node === null && <span style={{ color: 'var(--warn)' }}> (not found on the node, or its bytes hash to something else)</span>}
      </div>
      {walked.children.map((child) => (
        <Tree key={child.hash} walked={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export function VvshViewerPage() {
  const { state } = useApp();
  const [text, setText] = useState('');
  const raw = useRef<Uint8Array | null>(null);
  const [loaded, setLoaded] = useState('');
  const [cid, setCid] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [file, setFile] = useState<VvshFile | null>(null);
  const [tree, setTree] = useState<Walked | null>(null);
  const [chunks, setChunks] = useState<{ index: number; renditions: { id: string; size: number; frames: { i: number; p: number; b: number } }[] }[]>([]);
  const [playing, setPlaying] = useState<{ url: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = state?.nodes.find((node) => node.type === 'provider');

  /** Plays one chunk and nothing else: its own verified bytes, with the stream's init
   *  part prepended where the container needs one. */
  const playChunk = async (index: number, renditionId: string) => {
    try {
      setError(null);
      if (!provider || !file) return;
      const answer = await api<{ data: string }>('/api/vvsh/chunk', {
        body: { nodeId: provider.id, root: file.root, chunkCount: file.meta.chunkCount, index, rendition: renditionId },
      });
      const payload = fromBase64url(answer.data);
      const parts: Uint8Array[] = [];
      let type = file.meta.sourceMime ?? 'video/mp4';
      if (file.meta.codec === 'vvsh-webm/1') {
        type = 'video/webm';
        const rendition = file.meta.bitrates.find((entry) => entry.id === renditionId);
        if (rendition?.initHash) {
          const init = await api<{ data: string }>('/api/vvsh/object', { method: 'POST', body: { nodeId: provider.id, hash: rendition.initHash } });
          parts.push(fromBase64url(init.data));
        }
        parts.push(payload);
      } else {
        // The built-in container: its I/P/B frames decode to that chunk's piece of the file.
        parts.push(...decodeVvshFrames(decodeVvshChunk(payload)));
      }
      const url = URL.createObjectURL(new Blob(parts.map((part) => Uint8Array.from(part)), { type }));
      setPlaying((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { url, label: `chunk ${index} · ${renditionId}` };
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const parse = useCallback(
    async (source: Uint8Array | string) => {
      try {
        const parsed = parseVvshFile(source);
        setFile(parsed);
        setJsonText(JSON.stringify(vvshFileJson(parsed), null, 2));
        setLoaded(typeof source === 'string' ? 'pasted text' : `${source.length} bytes of packed data`);
        setError(null);
        setTree(null);
        setChunks([]);
        const providers = (state?.nodes ?? []).filter((node) => node.type === 'provider');
        if (!providers.length) return;
        // The objects may live on any provider — walk the first one that actually has them.
        let walked: Walked | null = null;
        for (const candidate of providers) {
          const attempt = await walk(candidate.id, parsed.root, 0, new Set());
          if (attempt.node) {
            walked = attempt;
            break;
          }
        }
        if (!walked) {
          setTree({ hash: parsed.root, node: null, children: [] });
          setError('The file parses fine, but none of the provider nodes here hold its objects.');
          return;
        }
        setTree(walked);
        const found: typeof chunks = [];
        const collect = (node: Walked) => {
          if (node.node?.kind === 'chunk' && node.node.renditions.length > 1) found.push({ index: node.node.index, renditions: node.node.renditions });
          node.children.forEach(collect);
        };
        collect(walked);
        setChunks(found.sort((a, b) => a.index - b.index));
      } catch (e) {
        // Pasting the packed bytes turns them to mojibake — say so instead of guessing.
        if (typeof source === 'string' && /[\u0000-\u0008\u000e-\u001f]/.test(source)) {
          setError('That looks like the packed binary. Use “Open file…” for it — pasting only works for the JSON form.');
        } else {
          setError(errorMessage(e));
        }
      }
    },
    [state, chunks]
  );

  const loadFromCid = useCallback(async () => {
    try {
      setError(null);
      // The content's metadata carries the root — walking down from it is exactly what
      // the player does, and here the tree is shown too.
      const view = await api<{ manifest?: { vvsh?: VvshFile } }>(`/api/content/${encodeURIComponent(cid.trim())}`);
      const vvsh = view.manifest?.vvsh;
      if (!vvsh) {
        setError('That content id is not a .vvsh video stream');
        return;
      }
      await parse(JSON.stringify(vvshFileJson(vvsh)));
      setLoaded(`from ${cid.trim()}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [cid, parse]);

  return (
    <div className="page">
      <div className="banner warn small">
        <strong>Temporary — for testing .vvsh files.</strong> Open the packed .vvsh file (or paste its JSON form), and if a provider node is
        added the tree is fetched from the root down, every step checked against its hash.
      </div>
      <div className="card form-stack">
        <label className="field">
          The .vvsh file
          <textarea
            rows={6}
            className="mono"
            value={text}
            onChange={(e) => {
              raw.current = null;
              setText(e.target.value);
            }}
            placeholder="Paste the JSON form here. Packed .vvsh files: use “Open file…” instead."
          />
        </label>
        <div className="row">
          <button className="primary small" onClick={() => void parse(raw.current ?? text)}>
            Parse
          </button>
          <label className="button small">
            Open file…
            <input
              type="file"
              accept=".vvsh,application/json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const picked = e.target.files?.[0];
                if (!picked) return;
                const bytes = new Uint8Array(await picked.arrayBuffer());
                raw.current = bytes;
                setText('');
                void parse(bytes);
              }}
            />
          </label>
          {loaded && <span className="hint">Loaded: {loaded}</span>}
        </div>
        <div className="row">
          <input
            type="text"
            className="mono"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="Content id (vs1…) — load the tree from the root in its metadata"
            value={cid}
            onChange={(e) => setCid(e.target.value)}
          />
          <button className="small" onClick={() => void loadFromCid()}>
            Load from id
          </button>
        </div>
        {error && <div className="banner danger small">{error}</div>}
      </div>
      {file && (
        <>
          <div className="card form-stack">
            <h3>Metadata</h3>
            <table className="table">
              <tbody>
                <tr>
                  <td>Data structure version</td>
                  <td>{file.meta.v}</td>
                </tr>
                <tr>
                  <td>Codec</td>
                  <td>{file.meta.codec}</td>
                </tr>
                <tr>
                  <td>Time per chunk</td>
                  <td>{file.meta.chunkSeconds}s</td>
                </tr>
                <tr>
                  <td>Chunks</td>
                  <td>{file.meta.chunkCount}</td>
                </tr>
                <tr>
                  <td>Total length</td>
                  <td>{file.meta.totalSeconds}s</td>
                </tr>
                <tr>
                  <td>Bitrate encodings</td>
                  <td>
                    {file.meta.bitrates
                      .map((rendition) => `${rendition.label} (${rendition.kbps} kbit/s${rendition.bytes ? ` · ${(rendition.bytes / (1024 * 1024)).toFixed(2)} MB` : ''})`)
                      .join(' · ')}
                  </td>
                </tr>
                <tr>
                  <td>Frames per chunk</td>
                  <td>
                    {file.meta.frames.gop} · {file.meta.frames.pattern}
                  </td>
                </tr>
                <tr>
                  <td>Previews</td>
                  <td>
                    {file.meta.previews
                      ? `${file.meta.previews.images.length} × ${file.meta.previews.seconds}s` +
                        (file.meta.previews.width ? ` · ${file.meta.previews.width}px` : '') +
                        (file.meta.previews.quality ? ` · quality ${file.meta.previews.quality}` : '')
                      : 'none'}
                  </td>
                </tr>
                <tr>
                  <td>Root</td>
                  <td className="mono">{file.root}</td>
                </tr>
              </tbody>
            </table>
            {file.meta.previews && (
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                {file.meta.previews.images.map((image, index) => (
                  <img key={index} src={image} alt={`Preview ${index + 1}`} style={{ height: 60, borderRadius: 4 }} />
                ))}
              </div>
            )}
          </div>
          <div className="card form-stack">
            <h3>Human-readable JSON</h3>
            <span className="hint">
              The .vvsh file itself is packed binary (magic <code>VVSH</code>: hashes as their raw 32 bytes, numbers as varints). This is the
              same data as JSON — edit it and re-parse to try changes; the tree records under it are packed the same way (<code>VVND</code>).
            </span>
            <textarea rows={10} className="mono" value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
            <div className="row">
              <button className="primary small" onClick={() => void parse(jsonText)}>
                Apply & re-parse
              </button>
            </div>
          </div>
          <div className="card form-stack">
            <h3>Merkle tree</h3>
            {tree ? <Tree walked={tree} /> : <p className="hint">{provider ? 'Fetching from the root down…' : 'Add a provider node to fetch the tree.'}</p>}
          </div>
          {chunks.length > 0 && (
            <div className="card form-stack">
              <h3>Chunks</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Chunk</th>
                    <th>Encodings</th>
                  </tr>
                </thead>
                <tbody>
                  {chunks.map((chunk) => (
                    <tr key={chunk.index}>
                      <td>{chunk.index}</td>
                      <td className="small">
                        {chunk.renditions.map((rendition) => (
                          <div key={rendition.id} className="row between" style={{ gap: 8 }}>
                            <span className="mono tiny">
                              {rendition.id}: {rendition.size} bytes · {rendition.frames.i} I / {rendition.frames.p} P / {rendition.frames.b} B
                            </span>
                            <button className="small ghost" onClick={() => void playChunk(chunk.index, rendition.id)}>
                              ▶ only this chunk
                            </button>
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {playing && (
                <div className="form-stack" style={{ marginTop: 12 }}>
                  <div className="row between">
                    <strong>Playing only {playing.label}</strong>
                    <button
                      className="small"
                      onClick={() =>
                        setPlaying((old) => {
                          if (old) URL.revokeObjectURL(old.url);
                          return null;
                        })
                      }
                    >
                      Close
                    </button>
                  </div>
                  <video key={playing.url} src={playing.url} controls autoPlay playsInline style={{ width: '100%', borderRadius: 8 }} />
                  <p className="hint">
                    Nothing before or after it: this is that chunk's own verified bytes (with the stream's init part prepended where the container
                    needs one). Chunks of `vvsh-frames/1` streams are a piece of the original file and may not play standing alone.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}