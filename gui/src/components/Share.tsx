import { Check, Copy, Download, ExternalLink, Link2, Mail, QrCode, Share2 } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { shareBase, shareLink } from '../../../src/shared/clientdefaults';
import { parseContentId } from '../../../src/shared/sources';
import { downloadBlob, qrSvg, svgToPng } from '../qr';
import { useApp } from '../state';
import { APP_BASE, copyText } from '../util';
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

type Mode = 'link' | 'qr';

function fileName(title: string | undefined, extension: string): string {
  const base = (title ?? 'vibeshare').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'vibeshare';
  return `${base}-qr.${extension}`;
}

function QrPanel({ url, title }: { url: string; title?: string }) {
  const { toast } = useApp();
  const svg = useMemo(() => qrSvg(url, 1024), [url]);
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

function ShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const { state, providers } = useApp();
  const [mode, setMode] = useState<Mode>('link');
  const [copied, setCopied] = useState(false);
  // The link defaults to the sharing address set in Settings — a hosted copy of the web
  // client — with the content id appended; when that address is empty it is the copy of
  // the client this page is open in. The
  // field stays editable: the url (content id included) can be changed before sharing.
  const defaultBase = (() => {
    // The sharing address in Settings (a hosted copy of the web client) overrides the
    // domain this page is served from whenever it is set to an address; where this page
    // is served from only stands in when that address is empty.
    let here = '';
    try {
      here = `${window.location.origin}${APP_BASE.pathname}`.replace(/\/+$/, '');
    } catch {
      here = '';
    }
    return shareBase(state?.settings.shareBaseUrl ?? '', here);
  })();
  const [edited, setEdited] = useState<string | null>(null);
  const native = Boolean(parseContentId(target.id)?.native);
  const provider = providers.find((node) => node.enabled);
  const url = edited ?? shareLink(defaultBase, target.id);
  const title = target.title ?? 'Content on VibeShare';
  const text = encodeURIComponent(title);
  const link = encodeURIComponent(url);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
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
      </div>

      <div className="share-link">
        <input type="text" value={url} onFocus={(e) => e.target.select()} aria-label="Link" onChange={(e) => setEdited(e.target.value)} />
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
      {mode === 'qr' && <QrPanel url={url} title={target.title} />}

      <div className="share-footer form-stack">
        <p className="hint">
          The link opens the VibeShare web client at <strong>{host}</strong>, which plays the content from its own nodes.{' '}
          <Link to="/settings?tab=sharing" className="link" onClick={onClose}>
            Change the address
          </Link>
        </p>
      </div>
    </Modal>
  );
}
