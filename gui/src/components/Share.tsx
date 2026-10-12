import { Check, Copy, Download, ExternalLink, Link2, Mail, QrCode, Share2 } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { shareLink } from '../../../src/shared/clientdefaults';
import { parseContentId } from '../../../src/shared/sources';
import { COLOR_QR, PLAIN_QR, QR_PALETTES, downloadBlob, qrSvg, svgToPng, type QrStyle } from '../qr';
import { useApp } from '../state';
import { copyText } from '../util';
import { Modal, Switch } from './ui';

export interface ShareTarget {
  id: string;
  title?: string;
}

const ShareContext = createContext<(target: ShareTarget) => void>(() => undefined);

/** Opens the share popup for a piece of content. */
export function useShare(): (target: ShareTarget) => void {
  return useContext(ShareContext);
}

export function ShareProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const share = useCallback((next: ShareTarget) => setTarget(next), []);
  return (
    <ShareContext.Provider value={share}>
      {children}
      {target && <ShareModal target={target} onClose={() => setTarget(null)} />}
    </ShareContext.Provider>
  );
}

export function ShareButton({ target, className = 'ghost icon', label }: { target: ShareTarget; className?: string; label?: string }) {
  const share = useShare();
  return (
    <button
      type="button"
      className={className}
      title="Share"
      aria-label={label ?? 'Share'}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        share(target);
      }}
    >
      <Share2 size={16} />
      {label}
    </button>
  );
}

type Mode = 'link' | 'qr' | 'color';

function fileName(title: string | undefined, extension: string): string {
  const base = (title ?? 'vibeshare').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'vibeshare';
  return `${base}-qr.${extension}`;
}

function QrPanel({ url, title, style }: { url: string; title?: string; style: QrStyle }) {
  const { toast } = useApp();
  const svg = useMemo(() => qrSvg(url, style, 1024), [url, style]);
  const preview = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, [svg]);
  const canCopyImage = typeof ClipboardItem !== 'undefined' && Boolean(navigator.clipboard?.write);
  return (
    <div className="qr-panel">
      <img className="qr-image" src={preview} alt={`QR code for ${url}`} width={248} height={248} />
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="small" onClick={async () => downloadBlob(await svgToPng(svg), fileName(title, 'png'))}>
          <Download size={14} /> PNG
        </button>
        <button className="small" onClick={() => downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), fileName(title, 'svg'))}>
          <Download size={14} /> SVG
        </button>
        {canCopyImage && (
          <button
            className="small"
            onClick={async () => {
              try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': svgToPng(svg) })]);
                toast('QR code copied', 'success');
              } catch {
                toast('Could not copy the image; download it instead', 'error');
              }
            }}
          >
            <Copy size={14} /> Copy image
          </button>
        )}
      </div>
    </div>
  );
}

function ColorOptions({ style, onChange }: { style: QrStyle; onChange: (style: QrStyle) => void }) {
  return (
    <div className="form-stack qr-options">
      <div className="row">
        {QR_PALETTES.map((palette) => {
          const on = palette.colors.join() === style.colors.join() && palette.eyes === style.eyes;
          return (
            <button
              key={palette.name}
              type="button"
              className={`swatch ${on ? 'on' : ''}`}
              title={palette.name}
              aria-label={palette.name}
              style={{ background: palette.colors.length > 1 ? `linear-gradient(135deg, ${palette.colors.join(', ')})` : palette.colors[0] }}
              onClick={() => onChange({ ...style, colors: palette.colors, eyes: palette.eyes })}
            />
          );
        })}
        <label className="swatch-custom" title="Your own colors">
          <input
            type="color"
            value={style.colors[0]}
            onChange={(e) => onChange({ ...style, colors: [e.target.value, style.colors[1] ?? e.target.value], eyes: e.target.value })}
          />
          <input type="color" value={style.colors[1] ?? style.colors[0]} onChange={(e) => onChange({ ...style, colors: [style.colors[0], e.target.value] })} />
        </label>
      </div>
      <div className="row">
        <select value={style.shape} onChange={(e) => onChange({ ...style, shape: e.target.value as QrStyle['shape'] })} style={{ width: 'auto' }}>
          <option value="dots">Dots</option>
          <option value="rounded">Rounded squares</option>
          <option value="square">Squares</option>
        </select>
        <Switch checked={style.logo} onChange={(logo) => onChange({ ...style, logo })} label="Logo" />
      </div>
    </div>
  );
}

function ShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const { state, providers } = useApp();
  const [mode, setMode] = useState<Mode>('link');
  const [copied, setCopied] = useState(false);
  const [withProvider, setWithProvider] = useState(false);
  const [colorStyle, setColorStyle] = useState<QrStyle>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('vs-qr-style') ?? 'null') as QrStyle | null;
      return saved && Array.isArray(saved.colors) ? { ...COLOR_QR, ...saved } : COLOR_QR;
    } catch {
      return COLOR_QR;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('vs-qr-style', JSON.stringify(colorStyle));
    } catch {
      // storage unavailable
    }
  }, [colorStyle]);

  const base = state?.settings.shareBaseUrl ?? '';
  const native = Boolean(parseContentId(target.id)?.native);
  const provider = providers.find((node) => node.enabled);
  const url = shareLink(base, target.id, withProvider && native && provider ? provider.ref : undefined);
  const title = target.title ?? 'Content on VibeShare';
  const text = encodeURIComponent(title);
  const link = encodeURIComponent(url);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return base;
    }
  })();
  const canShare = typeof navigator.share === 'function';

  const copy = async () => {
    await copyText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Modal title="Share" onClose={onClose}>
      <p className="small muted share-title" title={title}>
        {title}
      </p>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={mode === 'link'} className={mode === 'link' ? 'on' : ''} onClick={() => setMode('link')}>
          <Link2 size={15} /> Link
        </button>
        <button role="tab" aria-selected={mode === 'qr'} className={mode === 'qr' ? 'on' : ''} onClick={() => setMode('qr')}>
          <QrCode size={15} /> QR code
        </button>
        <button role="tab" aria-selected={mode === 'color'} className={mode === 'color' ? 'on' : ''} onClick={() => setMode('color')}>
          <QrCode size={15} className="rainbow" /> Color QR
        </button>
      </div>

      <div className="share-link">
        <input type="text" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Link" />
        <button className="primary" onClick={copy}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      {mode === 'link' && (
        <div className="share-targets">
          {canShare && (
            <button onClick={() => navigator.share({ title, url }).catch(() => undefined)}>
              <Share2 size={15} /> Share…
            </button>
          )}
          <a className="button" href={url} target="_blank" rel="noreferrer">
            <ExternalLink size={15} /> Open
          </a>
          <a className="button" href={`mailto:?subject=${text}&body=${link}`}>
            <Mail size={15} /> Email
          </a>
          <a className="button" href={`https://bsky.app/intent/compose?text=${encodeURIComponent(`${title} ${url}`)}`} target="_blank" rel="noreferrer">
            Bluesky
          </a>
          <a className="button" href={`https://x.com/intent/post?text=${text}&url=${link}`} target="_blank" rel="noreferrer">
            X
          </a>
          <a className="button" href={`https://www.reddit.com/submit?url=${link}&title=${text}`} target="_blank" rel="noreferrer">
            Reddit
          </a>
          <a className="button" href={`https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
          <a className="button" href={`https://t.me/share/url?url=${link}&text=${text}`} target="_blank" rel="noreferrer">
            Telegram
          </a>
        </div>
      )}
      {mode === 'qr' && <QrPanel url={url} title={target.title} style={PLAIN_QR} />}
      {mode === 'color' && (
        <>
          <QrPanel url={url} title={target.title} style={colorStyle} />
          <ColorOptions style={colorStyle} onChange={setColorStyle} />
        </>
      )}

      <div className="share-footer form-stack">
        {native && provider && (
          <Switch checked={withProvider} onChange={setWithProvider} label={`Point to my provider node (${provider.name})`} />
        )}
        <p className="hint">
          The link opens the VibeShare web client at <strong>{host}</strong>, which plays the content from its own nodes.{' '}
          <Link to="/settings#sharing" className="link" onClick={onClose}>
            Change the address
          </Link>
        </p>
      </div>
    </Modal>
  );
}
