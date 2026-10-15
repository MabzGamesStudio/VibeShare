// The dual screen: two pages side by side, each half showing a different tab — for
// example two vertical video scrolls at once, or a video grid next to a feed. The
// choice of each half is remembered.
import { useEffect, useState } from 'react';
import type { PageConfig } from '../../../src/shared/clientapi';
import { PageView } from '../components/feed/PageView';
import { Loading } from '../components/ui';
import { useApp } from '../state';

const LEFT_KEY = 'vs-dual-left';
const RIGHT_KEY = 'vs-dual-right';

/** One half of the screen: a picker of the user's tabs, and the chosen page below it. */
function Pane({
  side,
  pages,
  value,
  onChange,
}: {
  side: string;
  pages: PageConfig[];
  value: string;
  onChange: (id: string) => void;
}) {
  const page = pages.find((candidate) => candidate.id === value) ?? pages[0];
  return (
    <div className="dual-pane">
      <div className="dual-pane-bar">
        <select value={page?.id ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={`Tab of the ${side} half`}>
          {pages.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
      </div>
      <div className="dual-pane-body">{page && <PageView key={page.id} page={page} embedded />}</div>
    </div>
  );
}

export function DualPage() {
  const { state } = useApp();
  const pages = state?.settings.pages ?? [];
  // By default the left half is the vertical video scroll (Shorts) and the right half
  // the video page.
  const [left, setLeft] = useState(() => localStorage.getItem(LEFT_KEY) ?? 'shorts');
  const [right, setRight] = useState(() => localStorage.getItem(RIGHT_KEY) ?? 'videos');
  useEffect(() => localStorage.setItem(LEFT_KEY, left), [left]);
  useEffect(() => localStorage.setItem(RIGHT_KEY, right), [right]);

  if (!state) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }
  return (
    <div className="dual">
      <Pane side="left" pages={pages} value={left} onChange={setLeft} />
      <Pane side="right" pages={pages} value={right} onChange={setRight} />
    </div>
  );
}