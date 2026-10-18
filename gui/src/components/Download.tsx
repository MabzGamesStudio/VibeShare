// Downloading content locally: only content published on the network carries a content
// cid in the post, and only that can be fetched and saved as a file. The client checks
// every retrieved part against the expected cid exactly — when what a node or a link
// sends does not match it, nothing is saved and the mismatch message is shown instead.
import { Download } from 'lucide-react';
import { useState } from 'react';
import type { FeedItem } from '../../../src/shared/clientapi';
import { errorMessage, streamUrl } from '../api';
import { useMediaSrc } from '../media';

/** Saves the content at `url` to the device (a native content file). */
export function DownloadButton({ url, name, className = 'button', compact = false }: { url: string; name?: string; className?: string; compact?: boolean }) {
  const href = useMediaSrc(url);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const save = async () => {
    if (!href) return;
    setBusy(true);
    setFailed(null);
    try {
      const response = await fetch(href);
      if (!response.ok) {
        // The client refused to send the content on: a cid mismatch arrives as its own
        // message ("The downloaded content from the node/link does not match the expected
        // cid") and is shown here instead of saving anything.
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || `The download failed (${response.status})`);
      }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name ?? 'download';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      setFailed(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="form-stack">
      <button type="button" className={className} onClick={() => void save()} disabled={busy || !href} title="Download this content to your device">
        <Download size={16} /> {compact ? '' : 'Download'}
      </button>
      {failed ? <span className="banner danger small">{failed}</span> : null}
    </span>
  );
}

/** The download of a post — shown only when the post carries a content cid. */
export function PostDownload({ item, className = 'overlay-button', compact = true }: { item: FeedItem; className?: string; compact?: boolean }) {
  const cid = item.contentId;
  if (!cid) return null;
  return <DownloadButton url={streamUrl(cid, true)} name={item.title} className={className} compact={compact} />;
}
