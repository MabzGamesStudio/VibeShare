// The fields every publish form shares: the metadata block, the thumbnail picker, the
// node pickers and the sign-as-the-creator card. Publish's tabs and the video stream
// composer all use these, so the forms stay the same everywhere.
import { ImagePlus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { NodeEntry } from '../../../src/shared/clientapi';
import type { AlgorithmInfo, ProviderInfo } from '../../../src/shared/protocol';
import {
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATINGS,
  TOPICS,
  type CreatorKind,
  type Format,
  type Rating,
} from '../../../src/shared/taxonomy';
import { useApp } from '../state';
import { formatBytes, splitList } from '../util';
import { Chips, Switch, toggle } from './ui';

const MAX_THUMB = 190 * 1024;

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length * 0.75 < MAX_THUMB) return url;
  }
  return canvas.toDataURL('image/jpeg', 0.3);
}

function drawScaled(source: CanvasImageSource, width: number, height: number): string {
  const scale = Math.min(1, 640 / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToDataUrl(canvas);
}

export async function imageThumbnail(file: File): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    return drawScaled(bitmap, bitmap.width, bitmap.height);
  } catch {
    return undefined;
  }
}

/** Reads the duration of audio/video, and grabs a frame of video as the thumbnail. */
export function inspectMedia(file: File): Promise<{ duration?: number; thumbnail?: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = file.type.startsWith('video/');
    const element = document.createElement(video ? 'video' : 'audio');
    element.preload = 'metadata';
    element.muted = true;
    const done = (result: { duration?: number; thumbnail?: string }) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => done({}), 8000);
    element.onerror = () => {
      clearTimeout(timer);
      done({});
    };
    element.onloadedmetadata = () => {
      const duration = Number.isFinite(element.duration) ? element.duration : undefined;
      if (!video) {
        clearTimeout(timer);
        done({ duration });
        return;
      }
      const v = element as HTMLVideoElement;
      v.onseeked = () => {
        clearTimeout(timer);
        try {
          done({ duration, thumbnail: drawScaled(v, v.videoWidth, v.videoHeight) });
        } catch {
          done({ duration });
        }
      };
      v.currentTime = Math.min(2, (duration ?? 2) / 3);
    };
    element.src = url;
  });
}

export interface MetaState {
  title: string;
  description: string;
  format: Format;
  rating: Rating;
  topics: string[];
  /** Anything the topic list does not carry: free names or topic ids (tp1…). */
  extraTopics: string;
  language: string;
}

export const emptyMeta = (): MetaState => ({
  title: '',
  description: '',
  format: 'video',
  rating: 'all',
  topics: [],
  extraTopics: '',
  language: '',
});

/** The picked topics together with the additional ones, ready to publish. */
export function mergeTopics(meta: MetaState): string[] {
  const merged = [...meta.topics, ...splitList(meta.extraTopics)]
    .map((topic) => topic.trim().slice(0, 64))
    .filter(Boolean);
  return [...new Set(merged)].slice(0, 64);
}

export function MetaFields({ meta, setMeta, hideFormat }: { meta: MetaState; setMeta: (meta: MetaState) => void; hideFormat?: boolean }) {
  return (
    <>
      <label className="field">
        Title
        <input type="text" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} maxLength={300} />
      </label>
      <label className="field">
        Description
        <textarea value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} rows={4} maxLength={5000} />
      </label>
      <div className="form-grid">
        {!hideFormat && (
          <label className="field">
            Format
            <select value={meta.format} onChange={(e) => setMeta({ ...meta, format: e.target.value as Format })}>
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Age rating
          <select value={meta.rating} onChange={(e) => setMeta({ ...meta, rating: e.target.value as Rating })}>
            {RATINGS.map((r) => (
              <option key={r} value={r}>
                {RATING_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Language
          <input type="text" value={meta.language} onChange={(e) => setMeta({ ...meta, language: e.target.value })} placeholder="en" maxLength={16} />
        </label>
      </div>
      <div className="field">
        <span>Topics</span>
        <Chips options={TOPICS} selected={meta.topics} onToggle={(t) => setMeta({ ...meta, topics: toggle(meta.topics, t) })} />
      </div>
      <label className="field">
        Additional topics <span className="hint">Names or topic ids (tp1…) the list above does not carry — separated by commas.</span>
        <input
          type="text"
          value={meta.extraTopics}
          onChange={(e) => setMeta({ ...meta, extraTopics: e.target.value })}
          placeholder="tp1…, my-topic"
        />
      </label>
    </>
  );
}

/** The "Content data" fold: optional short key/value pairs kept on the content. */
export function ContentDataFields({ pairs, onChange }: { pairs: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  return (
    <details className="field">
      <summary style={{ cursor: 'pointer' }}>
        Content data <span className="hint">Optional key/value pairs kept on the content (up to 200)</span>
      </summary>
      <div className="form-stack" style={{ gap: 6, marginTop: 8 }}>
        {Object.entries(pairs).map(([pairKey, pairValue]) => (
          <div key={pairKey} className="card row between" style={{ padding: '6px 10px', margin: 0 }}>
            <span className="small mono">{pairKey}</span>
            <span className="small" style={{ flex: 1 }}>{pairValue}</span>
            <button
              type="button"
              className="small"
              onClick={() => {
                const next = { ...pairs };
                delete next[pairKey];
                onChange(next);
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="row" style={{ gap: 6 }}>
          <input type="text" className="mono" value={key} placeholder="Key" aria-label="Content data key" style={{ flex: 1 }} onChange={(e) => setKey(e.target.value)} />
          <input type="text" value={value} placeholder="Value" aria-label="Content data value" style={{ flex: 2 }} onChange={(e) => setValue(e.target.value)} />
          <button
            type="button"
            className="small"
            disabled={!key.trim() || Object.hasOwn(pairs, key.trim())}
            onClick={() => {
              const name = key.trim().slice(0, 80);
              if (!name) return;
              onChange({ ...pairs, [name]: value.slice(0, 1000) });
              setKey('');
              setValue('');
            }}
          >
            Add
          </button>
        </div>
      </div>
    </details>
  );
}

export function ThumbPicker({
  value,
  onChange,
  preview,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** What to show in the slot before a thumbnail is picked (the link's own preview). */
  preview?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [awaitPaste, setAwaitPaste] = useState(false);

  /** A clipboard picture becomes the thumbnail, in the same shape the picker stores. */
  const take = async (blob: Blob) => {
    const thumb = await imageThumbnail(new File([blob], 'clipboard', { type: blob.type }));
    if (thumb) {
      setNote('');
      onChange(thumb);
    } else {
      setNote('That picture could not be read.');
    }
  };

  const paste = async () => {
    setNote('');
    // The clipboard's own image items first.
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((entry) => entry.startsWith('image/'));
        if (type) return void (await take(await item.getType(type)));
      }
      setNote('There is no image on the clipboard — copy a picture first.');
      return;
    } catch {
      // Reads are denied in some browsers: fall back to a copied data: URL…
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (/^data:image\//i.test(text)) return void (await take(await (await fetch(text)).blob()));
    } catch {
      // …and then to the paste event below.
    }
    setNote('Clipboard access was denied — allow it in the browser, or press Ctrl+V here to paste the picture.');
    setAwaitPaste(true);
  };

  // The last resort when the browser refuses clipboard reads: the user pastes by hand
  // and the paste event carries the picture (one attempt).
  useEffect(() => {
    if (!awaitPaste) return;
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((entry) => entry.type.startsWith('image/'));
      setAwaitPaste(false);
      if (file) void take(file);
      else setNote('The pasted content has no picture.');
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitPaste]);

  return (
    <div className="field">
      <span>Thumbnail</span>
      <div className="preview-thumb" onClick={() => input.current?.click()} style={{ cursor: 'pointer' }}>
        {value ? <img src={value} alt="" /> : (preview ?? <ImagePlus size={32} className="faint" />)}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const picked = e.target.files?.[0];
          if (picked) onChange(await imageThumbnail(picked));
          e.target.value = '';
        }}
      />
      <div className="row" style={{ gap: 6, alignSelf: 'flex-start' }}>
        <button type="button" className="small" onClick={() => void paste()}>
          Paste image from clipboard
        </button>
        {value && (
          <button type="button" className="small" onClick={() => onChange(undefined)}>
            Remove
          </button>
        )}
      </div>
      {note && <span className="hint">{note}</span>}
    </div>
  );
}

export function NodePicker({
  nodes,
  selected,
  setSelected,
  describe,
}: {
  nodes: NodeEntry[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  describe: (node: NodeEntry) => string;
}) {
  if (!nodes.length) return <p className="small muted">None enabled. <Link className="link" to="/nodes">Add nodes</Link></p>;
  return (
    <div className="check-list">
      {nodes.map((node) => (
        <label key={node.id} className="check-item">
          <input type="checkbox" checked={selected.includes(node.id)} onChange={() => setSelected(toggle(selected, node.id))} />
          <div>
            <div style={{ fontWeight: 600 }}>{node.name}</div>
            <div className="tiny faint">{describe(node)}</div>
          </div>
        </label>
      ))}
    </div>
  );
}

export function describeProvider(node: NodeEntry): string {
  const info = node.info as ProviderInfo | undefined;
  if (!info) return node.url;
  const upload = info.pricing.upload;
  if (upload.mode === 'closed') return 'Does not accept uploads';
  return `${upload.mode === 'paid' ? `${upload.perMiB} credits/MiB` : 'Free uploads'} · up to ${formatBytes(upload.maxBytes)} · balance ${node.balance ?? '?'}`;
}

export function describeAlgorithm(node: NodeEntry): string {
  const info = node.info as AlgorithmInfo | undefined;
  if (!info) return node.url;
  return `${info.pricing.submission ? `${info.pricing.submission} credits per submission` : 'Free submissions'} · reviewed by the operator`;
}

/** Signing as the creator: the name is all the form asks for — the key is the identity. */
export function SignCard({ sign, setSign }: { sign: boolean; setSign: (sign: boolean) => void }) {
  const { state } = useApp();
  const profile = state?.settings.profile ?? { name: '', kind: 'unknown' as CreatorKind };
  return (
    <div className="card form-stack" style={{ padding: 16 }}>
      <Switch checked={sign} onChange={setSign} label="Sign as the creator" />
      {sign ? (
        <>
          <p className="tiny faint">Your public key proves you made it, so people can subscribe to you.</p>
          {/* Read-only: the name comes from the creator profile, not from here. */}
          <div className="small">
            {profile.name || <span className="faint">No creator name set</span>}
            <div className="hint">Change it in Settings → Creator profile.</div>
          </div>
        </>
      ) : (
        <p className="tiny faint">Published without a creator identity.</p>
      )}
    </div>
  );
}