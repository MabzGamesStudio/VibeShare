// The fields every publish form shares: the metadata block, the thumbnail picker, the
// node pickers and the sign-as-the-creator card. Publish's tabs and the video stream
// composer all use these, so the forms stay the same everywhere.
import { ImagePlus } from 'lucide-react';
import { useRef } from 'react';
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

export function ThumbPicker({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="field">
      <span>Thumbnail</span>
      <div className="preview-thumb" onClick={() => input.current?.click()} style={{ cursor: 'pointer' }}>
        {value ? <img src={value} alt="" /> : <ImagePlus size={32} className="faint" />}
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
      {value && (
        <button type="button" className="small" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(undefined)}>
          Remove
        </button>
      )}
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
  const { state, updateSettings } = useApp();
  const profile = state?.settings.profile ?? { name: '', kind: 'unknown' as CreatorKind };
  return (
    <div className="card form-stack" style={{ padding: 16 }}>
      <Switch checked={sign} onChange={setSign} label="Sign as the creator" />
      {sign ? (
        <>
          <p className="tiny faint">Your public key proves you made it, so people can subscribe to you.</p>
          <input
            type="text"
            defaultValue={profile.name}
            placeholder="Creator name"
            onBlur={(e) => e.target.value !== profile.name && void updateSettings({ profile: { ...profile, name: e.target.value } })}
          />
        </>
      ) : (
        <p className="tiny faint">Published without a creator identity.</p>
      )}
    </div>
  );
}