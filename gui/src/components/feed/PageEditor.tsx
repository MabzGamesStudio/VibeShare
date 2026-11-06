import { ArrowDown, ArrowUp, GalleryVertical, LayoutDashboard, LayoutGrid, List, RotateCcw, Smartphone, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  METADATA_FIELDS,
  METADATA_LABELS,
  PAGE_ICONS,
  PAGE_LAYOUT_LABELS,
  PAGE_LAYOUTS,
  type FeedItem,
  type MetadataField,
  type PageConfig,
  type PageFilters,
  type PageLayout,
  type PageSource,
} from '../../../../src/shared/clientapi';
import { presetPage } from '../../../../src/shared/clientdefaults';
import type { CreatorInfo, TopicInfo } from '../../../../src/shared/protocol';
import {
  CREATOR_KIND_LABELS,
  CREATOR_KINDS,
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATINGS,
  TOPICS,
  type CreatorKind,
  type Rating,
} from '../../../../src/shared/taxonomy';
import { useApp } from '../../state';
import { api } from '../../api';
import { gradientFor } from '../../util';
import { FormatIcon } from '../ContentCard';
import { Chips, Modal, Spinner, Switch, toggle } from '../ui';
import { Fields } from './Fields';
import { PAGE_ICON_COMPONENTS } from './icons';

/** Resolves what the user typed to a creator, group or topic one of the nodes knows. */
async function resolvePick(kind: 'creator' | 'topic', text: string): Promise<{ id: string; name: string } | null> {
  const query = text.trim();
  if (!query) return null;
  if (kind === 'topic') {
    const found = await api<{ topics: TopicInfo[] }>(`/api/topics?q=${encodeURIComponent(query)}`).catch(() => null);
    const topic = found?.topics.find((entry) => entry.id === query || entry.name.toLowerCase() === query.toLowerCase()) ?? found?.topics[0];
    return topic ? { id: topic.id, name: topic.name } : null;
  }
  const found = await api<{ creators: CreatorInfo[] }>(`/api/creators?q=${encodeURIComponent(query)}`).catch(() => null);
  const creator =
    found?.creators.find((entry) => entry.id === query) ??
    found?.creators.find((entry) => entry.name.toLowerCase() === query.toLowerCase()) ??
    found?.creators[0];
  return creator ? { id: creator.id, name: creator.kind === 'group' ? `${creator.name} · group` : creator.name } : null;
}

/**
 * The creators, groups or topics a page picked with its + button: every one of them is
 * either on the whitelist ("only these") or the blacklist. Membership is by id, so a
 * group id works wherever a creator id does.
 */
function PickList({
  kind,
  ids,
  blocked,
  only,
  labels,
  onOnly,
  onAdd,
  onRemove,
}: {
  kind: 'creator' | 'topic';
  ids: string[];
  blocked: string[];
  only: boolean;
  labels: Record<string, string>;
  onOnly: (only: boolean) => void;
  onAdd: (pick: { id: string; name: string }, list: 'allow' | 'block') => void;
  onRemove: (id: string, list: 'allow' | 'block') => void;
}) {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const label = kind === 'topic' ? 'Topic' : 'Creator or group';
  const missing = kind === 'topic' ? 'No topic matches that name yet' : 'No creator or group matches that name';

  const add = async (list: 'allow' | 'block') => {
    setBusy(true);
    try {
      const pick = await resolvePick(kind, text);
      if (!pick) {
        toast(missing, 'error');
        return;
      }
      onAdd(pick, list);
      setText('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-stack" style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder={`${label} name or id`}
          value={text}
          maxLength={128}
          onChange={(e) => setText(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <button type="button" className="small" disabled={busy || !text.trim()} onClick={() => void add('allow')} title="Only content of this one">
          + Whitelist
        </button>
        <button type="button" className="small" disabled={busy || !text.trim()} onClick={() => void add('block')} title="Never content of this one">
          + Blacklist
        </button>
      </div>
      {ids.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="hint">Whitelist</span>
          {ids.map((id) => (
            <button key={id} type="button" className="badge ok" onClick={() => onRemove(id, 'allow')} title="Remove from the whitelist">
              {labels[id] ?? id} ×
            </button>
          ))}
        </div>
      )}
      {blocked.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="hint">Blacklist</span>
          {blocked.map((id) => (
            <button key={id} type="button" className="badge danger" onClick={() => onRemove(id, 'block')} title="Remove from the blacklist">
              {labels[id] ?? id} ×
            </button>
          ))}
        </div>
      )}
      {ids.length > 0 && (
        <Switch
          checked={only}
          onChange={onOnly}
          label={kind === 'topic' ? 'Only content filed under these topics' : 'Only these creators (and everyone in these groups)'}
        />
      )}
    </div>
  );
}

export function pagePath(page: Pick<PageConfig, 'id'>): string {
  return page.id === 'videos' || page.id === 'home' ? '/' : `/p/${page.id}`;
}

const LAYOUT_ICONS: Record<PageLayout, typeof LayoutGrid> = {
  grid: LayoutGrid,
  list: List,
  shorts: Smartphone,
  stream: GalleryVertical,
  masonry: LayoutDashboard,
};

const SOURCE_LABELS: Record<PageSource, string> = {
  feed: 'Recommendations from your algorithm nodes',
  search: 'Search results',
  subscriptions: 'The newest from your subscriptions',
};

const SAMPLE: FeedItem = {
  id: 'yt:aqz-KE-bpKQ',
  status: 'listed',
  title: 'A sample title, as it would look on this page',
  description: 'The description of the content, shortened to a few lines.',
  format: 'video',
  rating: 'all',
  topics: ['science', 'nature'],
  tags: ['timelapse', 'space'],
  durationSeconds: 634,
  creator: { id: 'sample-creator', name: 'Creator name', kind: 'person' },
  publishedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
  stats: { likes: 1284, dislikes: 12, views: 482_000 },
  via: 'sample',
  viaName: 'Your algorithm node',
};

/** Chosen fields in order (with arrows to move them), then the others. */
function FieldPicker({ fields, onChange }: { fields: MetadataField[]; onChange: (fields: MetadataField[]) => void }) {
  const move = (index: number, delta: number) => {
    const next = [...fields];
    const [field] = next.splice(index, 1);
    next.splice(index + delta, 0, field);
    onChange(next);
  };
  const others = METADATA_FIELDS.filter((field) => !fields.includes(field));
  return (
    <div className="field-picker">
      {fields.map((field, index) => (
        <div key={field} className="field-picker-row on">
          <label className="row" style={{ gap: 8, flex: 1 }}>
            <input type="checkbox" checked onChange={() => onChange(fields.filter((f) => f !== field))} />
            {METADATA_LABELS[field]}
          </label>
          <button type="button" className="ghost icon small" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${METADATA_LABELS[field]} up`}>
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="ghost icon small"
            disabled={index === fields.length - 1}
            onClick={() => move(index, 1)}
            aria-label={`Move ${METADATA_LABELS[field]} down`}
          >
            <ArrowDown size={14} />
          </button>
        </div>
      ))}
      {others.map((field) => (
        <div key={field} className="field-picker-row">
          <label className="row" style={{ gap: 8, flex: 1 }}>
            <input type="checkbox" checked={false} onChange={() => onChange([...fields, field])} />
            {METADATA_LABELS[field]}
          </label>
        </div>
      ))}
    </div>
  );
}

function Preview({ page }: { page: PageConfig }) {
  const variant = page.layout === 'shorts' ? 'overlay' : page.layout === 'list' || page.layout === 'masonry' ? 'compact' : 'card';
  const thumb = page.thumbnail || page.layout === 'shorts' || page.layout === 'stream' || page.layout === 'masonry';
  return (
    <div className={`page-preview preview-${page.layout}`}>
      {thumb && (
        <div className="preview-thumb-box" style={{ background: gradientFor(page.id + page.layout) }}>
          <FormatIcon format={page.layout === 'shorts' ? 'short-video' : page.layout === 'stream' || page.layout === 'masonry' ? 'image' : 'video'} size={30} />
        </div>
      )}
      <div className="preview-fields">
        <Fields item={SAMPLE} fields={page.fields} variant={variant} />
      </div>
    </div>
  );
}

/** Edits a page: what it shows (source and filters) and how (layout, metadata, options). */
export function PageEditor({ page, isNew = false, onClose }: { page: PageConfig; isNew?: boolean; onClose: () => void }) {
  const { state, updateSettings } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [draft, setDraft] = useState<PageConfig>(() => structuredClone(page));
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const limit: Rating = state.settings.preferences.maxRating ?? '16+';

  const [labels, setLabels] = useState<Record<string, string>>({});
  const set = (patch: Partial<PageConfig>) => setDraft((current) => ({ ...current, ...patch }));
  const setFilters = (patch: Partial<PageFilters>) => setDraft((current) => ({ ...current, filters: { ...current.filters, ...patch } }));
  const setOptions = (patch: Partial<PageConfig['options']>) => setDraft((current) => ({ ...current, options: { ...current.options, ...patch } }));

  // Names for the creators, groups and topics the page already picked (they are stored as ids).
  const pickedKey = [
    ...(draft.filters.creatorIds ?? []),
    ...(draft.filters.blockedCreatorIds ?? []),
    ...(draft.filters.topicIds ?? []),
    ...(draft.filters.blockedTopicIds ?? []),
  ].join(' ');
  useEffect(() => {
    const unknown = (pickedKey ? pickedKey.split(' ') : []).filter((id) => !labels[id]);
    if (!unknown.length) return;
    let live = true;
    void Promise.all(
      unknown.map(async (id) => {
        const pick = await resolvePick(id.startsWith('tp1') ? 'topic' : 'creator', id);
        return pick && pick.id === id ? ([id, pick.name] as const) : null;
      })
    ).then((pairs) => {
      const found = pairs.filter((pair): pair is readonly [string, string] => pair !== null);
      if (live && found.length) setLabels((current) => ({ ...current, ...Object.fromEntries(found) }));
    });
    return () => {
      live = false;
    };
  }, [pickedKey, labels]);

  /** Adds one picked creator, group or topic to the whitelist or the blacklist. */
  const addPick = (kind: 'creator' | 'topic', list: 'allow' | 'block', pick: { id: string; name: string }) => {
    setLabels((current) => ({ ...current, [pick.id]: pick.name }));
    const add = (list2: string[] | undefined) => [...new Set([...(list2 ?? []), pick.id])];
    if (kind === 'topic') setFilters(list === 'allow' ? { topicIds: add(draft.filters.topicIds) } : { blockedTopicIds: add(draft.filters.blockedTopicIds) });
    else setFilters(list === 'allow' ? { creatorIds: add(draft.filters.creatorIds) } : { blockedCreatorIds: add(draft.filters.blockedCreatorIds) });
  };

  const removePick = (kind: 'creator' | 'topic', list: 'allow' | 'block', id: string) => {
    const drop = (list2: string[] | undefined) => (list2 ?? []).filter((value) => value !== id);
    if (kind === 'topic') setFilters(list === 'allow' ? { topicIds: drop(draft.filters.topicIds) } : { blockedTopicIds: drop(draft.filters.blockedTopicIds) });
    else setFilters(list === 'allow' ? { creatorIds: drop(draft.filters.creatorIds) } : { blockedCreatorIds: drop(draft.filters.blockedCreatorIds) });
  };

  const commit = async (pages: PageConfig[], then?: string) => {
    setBusy(true);
    const ok = await updateSettings({ pages });
    setBusy(false);
    if (!ok) return;
    onClose();
    if (then !== undefined) navigate(then);
  };
  const save = () => {
    const pages = isNew ? [...state.settings.pages, draft] : state.settings.pages.map((p) => (p.id === draft.id ? draft : p));
    void commit(pages, isNew ? pagePath(draft) : undefined);
  };
  const remove = () => {
    if (!confirm(`Delete the page “${page.title}”?`)) return;
    const here = location.pathname === pagePath(page);
    void commit(
      state.settings.pages.filter((p) => p.id !== page.id),
      here ? '/' : undefined
    );
  };

  const layout = draft.layout;
  const usesColumns = layout === 'grid' || layout === 'masonry';
  const plays = layout === 'shorts' || layout === 'stream';

  return (
    <Modal
      title={isNew ? 'New page' : `Customize “${page.title}”`}
      onClose={onClose}
      wide
      actions={
        <>
          {!isNew && page.preset && (
            <button className="ghost" onClick={() => setDraft({ ...presetPage(page.preset!), sidebar: draft.sidebar })} title="Back to how this page came">
              <RotateCcw size={15} /> Reset to default
            </button>
          )}
          {!isNew && !page.preset && (
            <button className="ghost danger" onClick={remove}>
              <Trash2 size={15} /> Delete page
            </button>
          )}
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy || !draft.title.trim()}>
            {busy && <Spinner />} {isNew ? 'Add page' : 'Save'}
          </button>
        </>
      }
    >
      <div className="editor">
        <section className="editor-section">
          <h3>Page</h3>
          <div className="form-grid">
            <label className="field">
              Title
              <input type="text" value={draft.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} autoFocus={isNew} />
            </label>
            <div className="field">
              <span>Left panel</span>
              <Switch checked={draft.sidebar} onChange={(sidebar) => set({ sidebar })} label="Show this page in the left panel" />
            </div>
          </div>
          <div className="field">
            <span>Icon</span>
            <div className="icon-picker">
              {PAGE_ICONS.map((icon) => {
                const Icon = PAGE_ICON_COMPONENTS[icon];
                return (
                  <button
                    key={icon}
                    type="button"
                    className={`ghost icon ${draft.icon === icon ? 'on' : ''}`}
                    aria-label={icon}
                    aria-pressed={draft.icon === icon}
                    onClick={() => set({ icon })}
                  >
                    <Icon size={18} />
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className="editor-section">
          <h3>Layout</h3>
          <div className="layout-picker">
            {PAGE_LAYOUTS.map((option) => {
              const Icon = LAYOUT_ICONS[option];
              return (
                <button key={option} type="button" className={`layout-option ${layout === option ? 'on' : ''}`} onClick={() => set({ layout: option })} aria-pressed={layout === option}>
                  <Icon size={20} />
                  <span>{PAGE_LAYOUT_LABELS[option]}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="editor-section">
          <h3>Content</h3>
          <div className="form-grid">
            <label className="field">
              Comes from
              <select value={draft.source} onChange={(e) => set({ source: e.target.value as PageSource })}>
                {(Object.keys(SOURCE_LABELS) as PageSource[]).map((source) => (
                  <option key={source} value={source}>
                    {SOURCE_LABELS[source]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Age rating up to
              <select value={draft.filters.maxRating ?? ''} onChange={(e) => setFilters({ maxRating: (e.target.value || undefined) as Rating | undefined })}>
                <option value="">My limit ({RATING_LABELS[limit]})</option>
                {RATINGS.slice(0, RATINGS.indexOf(limit) + 1).map((rating) => (
                  <option key={rating} value={rating}>
                    {RATING_LABELS[rating]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {draft.source === 'search' && (
            <div className="form-grid">
              <label className="field">
                Search for <span className="hint">Words, #tags, @creators — empty lists everything</span>
                <input type="text" value={draft.query ?? ''} maxLength={200} onChange={(e) => set({ query: e.target.value })} placeholder="#timelapse @NASA space" />
              </label>
              <label className="field">
                Order
                <select value={draft.filters.sort ?? 'relevance'} onChange={(e) => setFilters({ sort: e.target.value as PageFilters['sort'] })}>
                  <option value="relevance">Most relevant</option>
                  <option value="new">Newest</option>
                  <option value="top">Top rated</option>
                </select>
              </label>
            </div>
          )}
          <div className="field">
            <span>
              Formats <span className="hint">None selected = every format</span>
            </span>
            <Chips options={FORMATS} selected={draft.filters.formats} labels={FORMAT_LABELS} onToggle={(f) => setFilters({ formats: toggle(draft.filters.formats, f) })} />
          </div>
          <div className="field">
            <span>
              Topics <span className="hint">None selected = your favourite topics</span>
            </span>
            <Chips options={TOPICS} selected={draft.filters.topics} onToggle={(t) => setFilters({ topics: toggle(draft.filters.topics, t) })} />
            {draft.filters.topics.length > 0 && (
              <Switch checked={draft.filters.onlyTopics} onChange={(onlyTopics) => setFilters({ onlyTopics })} label="Only these topics" />
            )}
            <PickList
              kind="topic"
              ids={draft.filters.topicIds ?? []}
              blocked={draft.filters.blockedTopicIds ?? []}
              only={draft.filters.onlyTopicIds ?? false}
              labels={labels}
              onOnly={(onlyTopicIds) => setFilters({ onlyTopicIds })}
              onAdd={(pick, list) => addPick('topic', list, pick)}
              onRemove={(id, list) => removePick('topic', list, id)}
            />
          </div>
          <div className="field">
            <span>
              Creators <span className="hint">None selected = everyone</span>
            </span>
            <Chips
              options={CREATOR_KINDS.filter((k) => k !== 'unknown')}
              selected={draft.filters.creatorKinds}
              labels={CREATOR_KIND_LABELS}
              onToggle={(k) => setFilters({ creatorKinds: toggle(draft.filters.creatorKinds, k as CreatorKind) })}
            />
            <PickList
              kind="creator"
              ids={draft.filters.creatorIds ?? []}
              blocked={draft.filters.blockedCreatorIds ?? []}
              only={draft.filters.onlyCreators ?? false}
              labels={labels}
              onOnly={(onlyCreators) => setFilters({ onlyCreators })}
              onAdd={(pick, list) => addPick('creator', list, pick)}
              onRemove={(id, list) => removePick('creator', list, id)}
            />
          </div>
        </section>

        <section className="editor-section">
          <h3>Display</h3>
          <div className="editor-display">
            <div className="form-stack">
              {(layout === 'grid' || layout === 'list') && (
                <Switch checked={draft.thumbnail} onChange={(thumbnail) => set({ thumbnail })} label="Image preview" />
              )}
              <div className="field">
                <span>
                  Shown with each item <span className="hint">In this order</span>
                </span>
                <FieldPicker fields={draft.fields} onChange={(fields) => set({ fields })} />
              </div>
            </div>
            <div className="form-stack">
              <div className="field">
                <span>Preview</span>
                <Preview page={draft} />
              </div>
              {layout !== 'shorts' && (
                <label className="field">
                  Size
                  <select value={draft.options.size} onChange={(e) => setOptions({ size: e.target.value as PageConfig['options']['size'] })}>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </label>
              )}
              {usesColumns && (
                <label className="field">
                  Columns
                  <select value={draft.options.columns} onChange={(e) => setOptions({ columns: Number(e.target.value) })}>
                    <option value={0}>As many as fit</option>
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {plays && (
                <>
                  <Switch
                    checked={draft.options.autoplay}
                    onChange={(autoplay) => setOptions({ autoplay })}
                    label={layout === 'shorts' ? 'Play each short as it comes into view' : 'Play videos as they scroll into view'}
                  />
                  <Switch checked={draft.options.muted} onChange={(muted) => setOptions({ muted })} label="Start muted" />
                  <p className="hint">Browsers only start videos by themselves when they are muted; unmute with one tap.</p>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}
