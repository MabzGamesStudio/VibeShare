// TEMPORARY — a page to open and parse a .vvsh file for testing: its metadata, the merkle
// tree (fetched and verified node by node from the root) and every chunk with its bitrate
// leaves and I/P/B frame counts. Not part of the product; it comes out again once the
// format settles.
import { useCallback, useState } from 'react';
import { useApp } from '../state';
import { api, errorMessage } from '../api';
import { fromBase64url } from '../../../src/shared/encoding.js';
import { parseVvshFile, parseVvshNode, vvshFileJson, type VvshFile, type VvshNode } from '../../../src/shared/vvsh.js';

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
        {walked.node === null && <span style={{ color: 'var(--warn)' }}> (hash does not match!)</span>}
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
  const [jsonText, setJsonText] = useState('');
  const [file, setFile] = useState<VvshFile | null>(null);
  const [tree, setTree] = useState<Walked | null>(null);
  const [chunks, setChunks] = useState<{ index: number; renditions: { id: string; size: number; frames: { i: number; p: number; b: number } }[] }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const provider = state?.nodes.find((node) => node.type === 'provider');

  const parse = useCallback(
    async (source: Uint8Array | string) => {
      try {
        const parsed = parseVvshFile(source);
        setFile(parsed);
        setJsonText(JSON.stringify(vvshFileJson(parsed), null, 2));
        setError(null);
        setTree(null);
        setChunks([]);
        if (!provider) return;
        const walked = await walk(provider.id, parsed.root, 0, new Set());
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
    [provider, chunks]
  );

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
            onChange={(e) => setText(e.target.value)}
            placeholder='{ "format": "vvsh", "meta": { … }, "root": "chk1…" }'
          />
        </label>
        <div className="row">
          <button className="primary small" onClick={() => void parse(text)}>
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
                setText(picked.name);
                void parse(new Uint8Array(await picked.arrayBuffer()));
              }}
            />
          </label>
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
                  <td>{file.meta.bitrates.map((rendition) => `${rendition.label} (${rendition.kbps} kbit/s)`).join(' · ')}</td>
                </tr>
                <tr>
                  <td>Frames per chunk</td>
                  <td>
                    {file.meta.frames.gop} · {file.meta.frames.pattern}
                  </td>
                </tr>
                <tr>
                  <td>Previews</td>
                  <td>{file.meta.previews ? `${file.meta.previews.images.length} × ${file.meta.previews.seconds}s` : 'none'}</td>
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
                          <div key={rendition.id} className="mono tiny">
                            {rendition.id}: {rendition.size} bytes · {rendition.frames.i} I / {rendition.frames.p} P / {rendition.frames.b} B
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}