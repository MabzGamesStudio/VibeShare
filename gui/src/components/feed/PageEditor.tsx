import { ArrowDown, ArrowUp, GalleryVertical, LayoutDashboard, LayoutGrid, List, RotateCcw, Smartphone, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AgeRatingPicker } from '../AgeRatingPicker';
import { UNKNOWN_AGE_RATING_TOPIC } from '../../../../src/shared/age-rating';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  METADATA_FIELDS,
  METADATA_LABELS,
  PAGE_ICONS,
  PAGE_LAYOUT_LABELS,
  PAGE_LAYOUTS,
  DEFAULT_SHORT_BUTTONS,
  SHORT_BUTTONS,
  SHORT_BUTTON_LABELS,
  type FeedItem,
  type MetadataField,
  type PageConfig,
  type PageFilters,
  type PageLayout,
  type PageSource,
  type ShortButton,
} from '../../../../src/shared/clientapi';
import { DEFAULT_BLOCKED_TOPICS, presetPage } from '../../../../src/shared/clientdefaults';
import type { CreatorInfo, TopicInfo } from '../../../../src/shared/protocol';
import {
  FORMAT_LABELS,
  FORMATS,
  RATING_LABELS,
  RATING_REASONS,
  RATINGS,
  SUGGEST_LEVEL_LABELS,
  SUGGEST_LEVELS,
  TOPICS,
  topicIdOf,
  type Rating,
  type SuggestLevel,
} from '../../../../src/shared/taxonomy';
import { SOURCE_CATALOG } from '../../../../src/algorithm/sources';
import { sourceSchemeLabel } from '../../../../src/shared/sources';
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


/** A slider for one section's level: only show, strongly suggest, suggest, weakly suggest, ignore. */
export function LevelSlider({ label, value, onChange }: { label: string; value: SuggestLevel; onChange: (level: SuggestLevel) => void }) {
  return (
    <label className="field" style={{ marginTop: 10 }}>
      <span>
        {label} <span className="hint">{SUGGEST_LEVEL_LABELS[value]}</span>
      </span>
      <input
        type="range"
        min={0}
        max={SUGGEST_LEVELS.length - 1}
        step={1}
        value={SUGGEST_LEVELS.indexOf(value)}
        onChange={(e) => onChange(SUGGEST_LEVELS[Number(e.target.value)] ?? 'ignore')}
      />
    </label>
  );
}

export type PickEntry = { id: string; label: string; state: 'on' | 'off' | 'block' };

/** The buttons of one pick list: white (on), deselected, or blacklisted (red); each click cycles. */
export function PickButtons({ entries, onCycle }: { entries: PickEntry[]; onCycle: (id: string) => void }) {
  return (
    <div className="chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`chip ${entry.state === 'on' ? 'on' : entry.state === 'block' ? 'blocked' : ''}`}
          title={entry.state === 'on' ? 'Selected — click to deselect' : entry.state === 'off' ? 'Deselected — click to blacklist' : 'Blacklisted — click to select'}
          onClick={() => onCycle(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/** The row that adds one more pick: a name or an id the user types. */
export function AddPickRow({ kind, onAdd }: { kind: 'topic' | 'creator'; onAdd: (pick: { id: string; name: string }) => void }) {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const query = text.trim();
    if (!query) return;
    setBusy(true);
    try {
      const missing = kind === 'topic' ? 'No topic matches that name' : 'No creator matches that name';
      const topicId = query.startsWith('tp1') ? query : topicIdOf(query);
      const pick = await resolvePick(kind, query);
      // A topic is added exactly as the user typed it: a resolved pick only counts when
      // it IS that topic (its id or its name) — the fuzzy first match never replaces the
      // user's words ("thing" is not "thingaweek"). Creators keep resolving to whatever
      // the nodes know.
      const exact = pick && (kind !== 'topic' || pick.id === topicId || pick.name.toLowerCase() === query.toLowerCase());
      if (exact) onAdd(pick);
      else if (kind === 'topic') onAdd({ id: topicId, name: query });
      else if (!/\s/.test(query) && /^[a-z0-9]+[:._~-]/i.test(query)) onAdd({ id: query, name: query });
      else toast(missing, 'error');
      setText('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ gap: 8, marginTop: 10 }}>
      <input
        type="text"
        value={text}
        placeholder={kind === 'topic' ? 'Add a topic or topic id' : 'Add a creator or creator id'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void add()}
        style={{ flex: 1 }}
      />
      <button className="small" disabled={busy || !text.trim()} onClick={() => void add()}>
        {busy ? <Spinner /> : null} Add
      </button>
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

/** Edits a page: what it shows and how — every change is saved immediately and automatically. */
export function PageEditor({ page, isNew = false, onClose }: { page: PageConfig; isNew?: boolean; onClose: () => void }) {
  const { state, updateSettings, toast } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [draft, setDraft] = useState<PageConfig>(() => ({ ...page, filters: { ...page.filters }, options: { ...page.options } }));
  // The default-excluded topics carry their names from the start, so they show as
  // "ai-slop" and "rage-bait" (in the block state) even before any node knows them.
  const [labels, setLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries(DEFAULT_BLOCKED_TOPICS.map((name) => [topicIdOf(name), name]))
  );
  // Topics and creators deselected in this modal: shown dimmed so a click can still cycle
  // them to blacklisted, but never written to the page — a deselected pick is forgotten.
  const [dropped, setDropped] = useState<{ topic: string[]; creator: string[] }>({ topic: [], creator: [] });
  const [tab, setTab] = useState<'appearance' | 'content' | 'display'>('appearance');
  const [busy, setBusy] = useState(false);
  const [suggested, setSuggested] = useState<{ topics: { id: string; name: string }[]; creators: { id: string; name: string }[] }>({ topics: [], creators: [] });

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = useRef(false);
  const created = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  // There is no Save button: each change is written through shortly after it is made.
  const persist = async () => {
    if (!state) return;
    const next = draftRef.current;
    const pages = isNew && !created.current ? [...state.settings.pages, next] : state.settings.pages.map((p) => (p.id === next.id ? next : p));
    setBusy(true);
    const ok = await updateSettings({ pages });
    setBusy(false);
    if (ok) created.current = true;
  };
  const scheduleSave = () => {
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void persist(), 300);
  };
  // Closing the modal flushes whatever is still pending.
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (dirty.current) void persist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (patch: Partial<PageConfig>) => {
    setDraft((current) => ({ ...current, ...patch }));
    scheduleSave();
  };
  const setFilters = (patch: Partial<PageFilters>) => {
    setDraft((current) => ({ ...current, filters: { ...current.filters, ...patch } }));
    scheduleSave();
  };
  const setOptions = (patch: Partial<PageConfig['options']>) => {
    setDraft((current) => ({ ...current, options: { ...current.options, ...patch } }));
    scheduleSave();
  };

  // Names for the creators, groups and topics the page picked (they are stored as ids).
  const pickedKey = [
    ...(draft.filters.topics ?? []),
    ...(draft.filters.topicIds ?? []),
    ...(draft.filters.blockedTopicIds ?? []),
    ...(draft.filters.creatorIds ?? []),
    ...(draft.filters.blockedCreatorIds ?? []),
    ...dropped.topic,
    ...dropped.creator,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey]);

  // What the algorithm search nodes suggest: a few topics and creators to pick from.
  useEffect(() => {
    let live = true;
    void api<{ topics: TopicInfo[] }>('/api/topics?q=')
      .then((found) => {
        if (!live) return;
        const list = found.topics.slice(0, 8).map((topic) => ({ id: topic.id, name: topic.name }));
        setSuggested((current) => ({ ...current, topics: list.length ? list : TOPICS.slice(0, 8).map((name) => ({ id: topicIdOf(name), name })) }));
      })
      .catch(() => {
        if (live) setSuggested((current) => ({ ...current, topics: TOPICS.slice(0, 8).map((name) => ({ id: topicIdOf(name), name })) }));
      });
    void api<{ creators: CreatorInfo[] }>('/api/creators?q=')
      .then((found) => {
        if (live) setSuggested((current) => ({ ...current, creators: found.creators.slice(0, 8).map((creator) => ({ id: creator.id, name: creator.name })) }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const entriesOf = (kind: 'topic' | 'creator'): PickEntry[] => {
    const f = draft.filters;
    const label = (id: string) => labels[id] ?? id;
    const on = kind === 'topic' ? [...(f.topics ?? []), ...(f.topicIds ?? [])] : [...(f.creatorIds ?? [])];
    const off = dropped[kind];
    const block = kind === 'topic' ? (f.blockedTopicIds ?? []) : (f.blockedCreatorIds ?? []);
    return [
      ...on.map((id) => ({ id, label: label(id), state: 'on' as const })),
      ...off.map((id) => ({ id, label: label(id), state: 'off' as const })),
      ...block.map((id) => ({ id, label: label(id), state: 'block' as const })),
    ];
  };
  const topicPicked = entriesOf('topic');
  const creatorPicked = entriesOf('creator');
  // Suggestions from the algorithm search nodes sit inline after the picked ones, shown
  // unselected; clicking one selects it (then it cycles like any other pick).
  const isPicked = (kind: 'topic' | 'creator', id: string) => (kind === 'topic' ? topicPicked : creatorPicked).some((entry) => entry.id === id);
  const suggestName = (kind: 'topic' | 'creator', id: string) =>
    (kind === 'topic' ? suggested.topics : suggested.creators).find((entry) => entry.id === id)?.name ?? labels[id] ?? id;
  const topicEntries: PickEntry[] = [
    ...topicPicked,
    ...suggested.topics.filter((entry) => !isPicked('topic', entry.id)).map((entry) => ({ id: entry.id, label: entry.name, state: 'off' as const })),
  ];
  const creatorEntries: PickEntry[] = [
    ...creatorPicked,
    ...suggested.creators.filter((entry) => !isPicked('creator', entry.id)).map((entry) => ({ id: entry.id, label: entry.name, state: 'off' as const })),
  ];
  const cycleOrPick = (kind: 'topic' | 'creator', id: string) => {
    if (isPicked(kind, id)) cyclePick(kind, id);
    else addPick(kind, { id, name: suggestName(kind, id) });
  };

  /** One click cycles a pick: selected → deselected → blacklisted → selected. */
  const cyclePick = (kind: 'topic' | 'creator', id: string) => {
    const f = draft.filters;
    const on = kind === 'topic' ? [...(f.topics ?? []), ...(f.topicIds ?? [])] : [...(f.creatorIds ?? [])];
    const off = dropped[kind];
    const block = kind === 'topic' ? (f.blockedTopicIds ?? []) : (f.blockedCreatorIds ?? []);
    const drop = (list: string[]) => list.filter((value) => value !== id);
    if (on.includes(id)) {
      setDropped((current) => ({ ...current, [kind]: [...current[kind], id] }));
      if (kind === 'topic') setFilters({ topics: drop(f.topics ?? []), topicIds: drop(f.topicIds ?? []) });
      else setFilters({ creatorIds: drop(f.creatorIds ?? []) });
    } else if (off.includes(id)) {
      setDropped((current) => ({ ...current, [kind]: drop(current[kind]) }));
      if (kind === 'topic') setFilters({ blockedTopicIds: [...new Set([...(f.blockedTopicIds ?? []), id])] });
      else setFilters({ blockedCreatorIds: [...new Set([...(f.blockedCreatorIds ?? []), id])] });
    } else if (block.includes(id)) {
      if (kind === 'topic') setFilters({ blockedTopicIds: drop(f.blockedTopicIds ?? []), topicIds: [...new Set([...(f.topicIds ?? []), id])] });
      else setFilters({ blockedCreatorIds: drop(f.blockedCreatorIds ?? []), creatorIds: [...new Set([...(f.creatorIds ?? []), id])] });
    }
  };

  const addPick = (kind: 'topic' | 'creator', pick: { id: string; name: string }) => {
    setLabels((current) => ({ ...current, [pick.id]: pick.name }));
    setDropped((current) => ({ ...current, [kind]: current[kind].filter((id) => id !== pick.id) }));
    const f = draft.filters;
    const keep = (list: string[] | undefined) => (list ?? []).filter((id) => id !== pick.id);
    if (kind === 'topic') {
      setFilters({
        topics: keep(f.topics),
        topicIds: [...new Set([...keep(f.topicIds), pick.id])],
        blockedTopicIds: keep(f.blockedTopicIds),
      });
    } else {
      setFilters({
        creatorIds: [...new Set([...keep(f.creatorIds), pick.id])],
        blockedCreatorIds: keep(f.blockedCreatorIds),
      });
    }
  };

  const handleReset = () => {
    const preset = page.preset;
    if (!preset) return;
    setDraft((current) => ({ ...presetPage(preset), id: current.id }));
    scheduleSave();
  };

  const remove = () => {
    if (!state || !confirm(`Delete the page “${page.title}”?`)) return;
    void (async () => {
      setBusy(true);
      const ok = await updateSettings({ pages: state.settings.pages.filter((p) => p.id !== page.id) });
      setBusy(false);
      if (!ok) return;
      dirty.current = false;
      onClose();
      if (location.pathname === pagePath(page)) navigate('/');
    })();
  };
  const layout = draft.layout;
  const usesColumns = layout === 'grid' || layout === 'masonry';
  const plays = layout === 'shorts' || layout === 'stream';
  const formatLevel: SuggestLevel = draft.filters.formatLevel ?? 'only';
  const topicLevel: SuggestLevel = draft.filters.topicLevel ?? (draft.filters.onlyTopics ? 'only' : 'strongly');
  const creatorLevel: SuggestLevel = draft.filters.creatorLevel ?? (draft.filters.onlyCreators ? 'only' : 'ignore');
  const platformLevel: SuggestLevel = draft.filters.platformLevel ?? 'ignore';
  // Platforms (content sources like youtube): whitelist → blacklist → unselected, cycling.
  const platformState = (id: string): 'on' | 'off' | 'block' =>
    (draft.filters.platforms ?? []).includes(id) ? 'on' : (draft.filters.blockedPlatforms ?? []).includes(id) ? 'block' : 'off';
  const platformEntries: PickEntry[] = SOURCE_CATALOG.map((source) => ({
    id: source.key,
    label: sourceSchemeLabel(source.key) ?? source.key,
    state: platformState(source.key),
  }));
  const cyclePlatform = (id: string) => {
    const f = draft.filters;
    const keep = (list: string[] | undefined) => (list ?? []).filter((value) => value !== id);
    const state = platformState(id);
    if (state === 'on') setFilters({ platforms: keep(f.platforms), blockedPlatforms: [...new Set([...keep(f.blockedPlatforms), id])] });
    else if (state === 'block') setFilters({ blockedPlatforms: keep(f.blockedPlatforms) });
    else setFilters({ platforms: [...new Set([...keep(f.platforms), id])], blockedPlatforms: keep(f.blockedPlatforms) });
  };

  return (
    <Modal title={isNew ? 'New page' : `Customize “${page.title}”`} onClose={onClose} wide>
      <div className="tabs" style={{ marginBottom: 14 }}>
        {([['appearance', 'Appearance'], ['content', 'Content'], ['display', 'Display']] as const).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <div className="spacer" />
        <span className="hint">{busy ? 'Saving…' : 'Changes are saved automatically'}</span>
      </div>

      {tab === 'appearance' && (
        <section className="editor-section">
          <h3>Appearance</h3>
          <div className="form-stack">
            <label className="field">
              Title
              <input type="text" value={draft.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} />
            </label>
            <div className="field switch-row">
              <span>Show in left panel</span>
              <Switch checked={draft.sidebar} onChange={(sidebar) => set({ sidebar })} />
            </div>
            <div className="field">
              <span>Icon</span>
              <div className="icon-grid">
                {PAGE_ICONS.map((icon) => {
                  const Icon = PAGE_ICON_COMPONENTS[icon];
                  return (
                    <button key={icon} type="button" title={icon} className={`icon-option ${draft.icon === icon ? 'on' : ''}`} onClick={() => set({ icon })}>
                      <Icon size={20} />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="field">
              <span>Layout</span>
              <div className="icon-grid">
                {PAGE_LAYOUTS.map((name) => {
                  const Icon = LAYOUT_ICONS[name];
                  return (
                    <button key={name} type="button" title={PAGE_LAYOUT_LABELS[name]} className={`icon-option ${layout === name ? 'on' : ''}`} onClick={() => set({ layout: name })}>
                      <Icon size={20} /> {PAGE_LAYOUT_LABELS[name]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      )}
      {tab === 'content' && (
        <>
          <section className="editor-section">
            <h3>Comes from</h3>
            <div className="form-grid">
              <label className="field">
                Content
                <select value={draft.source} onChange={(e) => set({ source: e.target.value as PageSource })}>
                  {Object.entries(SOURCE_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {draft.source === 'search' && (
                <>
                  <label className="field">
                    Search for
                    <input type="text" value={draft.query ?? ''} placeholder="#topics, @creators, words" onChange={(e) => set({ query: e.target.value })} />
                  </label>
                  <label className="field">
                    Order
                    <select value={draft.filters.sort ?? 'relevance'} onChange={(e) => setFilters({ sort: e.target.value as PageFilters['sort'] })}>
                      <option value="relevance">Most relevant</option>
                      <option value="new">Newest</option>
                      <option value="top">Most liked</option>
                    </select>
                  </label>
                </>
              )}
            </div>
          </section>

          <section className="editor-section">
            <h3>Age rating</h3>
            <div className="form-stack">
              <label className="field">
                Highest age rating
                <select value={draft.filters.maxRating ?? '16+'} onChange={(e) => setFilters({ maxRating: e.target.value as Rating })}>
                  {RATINGS.map((rating) => (
                    <option key={rating} value={rating}>
                      {RATING_LABELS[rating]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span>
                  Rated as <span className="hint">Unknown shows everything</span>
                </span>
                {/* The age rating rides along as one age-rating topic, applied like any
                    other topic filter. Unknown carries no filter at all. */}
                <AgeRatingPicker
                  topics={draft.filters.topics ?? []}
                  onChange={(topics) => setFilters({ topics: topics.filter((topic) => topic !== UNKNOWN_AGE_RATING_TOPIC) })}
                />
              </div>
              <div className="field">
                <span>
                  Disregard <span className="hint">Never show content about these</span>
                </span>
                <Chips
                  options={RATING_REASONS}
                  selected={draft.filters.disregard ?? []}
                  onToggle={(reason) => setFilters({ disregard: toggle(draft.filters.disregard ?? [], reason) })}
                />
              </div>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              The content types to disregard go to your algorithm search nodes with the request, and the client itself checks every item's metadata
              against them before showing it.
            </p>
          </section>

          <section className="editor-section">
            <h3>Formats</h3>
            <Chips options={FORMATS} selected={draft.filters.formats} labels={FORMAT_LABELS} onToggle={(format) => setFilters({ formats: toggle(draft.filters.formats, format) })} />
            <LevelSlider label="Weigh the chosen formats" value={formatLevel} onChange={(level) => setFilters({ formatLevel: level })} />
          </section>

          <section className="editor-section">
            <h3>Platforms</h3>
            <PickButtons entries={platformEntries} onCycle={cyclePlatform} />
            <LevelSlider
              label="Include or exclude the chosen platforms"
              value={platformLevel}
              onChange={(level) => setFilters({ platformLevel: level })}
            />
          </section>
          <section className="editor-section">
            <h3>Topics</h3>
            <PickButtons entries={topicEntries} onCycle={(id) => cycleOrPick('topic', id)} />
            <AddPickRow kind="topic" onAdd={(pick) => addPick('topic', pick)} />
            <LevelSlider label="Weigh the chosen topics" value={topicLevel} onChange={(level) => setFilters({ topicLevel: level })} />
          </section>

          <section className="editor-section">
            <h3>Creators</h3>
            <PickButtons
              entries={[
                { id: '__subscribed__', label: 'Subscribed creators', state: draft.filters.subscribedCreators !== false ? 'on' : 'off' },
                ...creatorEntries,
              ]}
              onCycle={(id) => {
                if (id === '__subscribed__') setFilters({ subscribedCreators: draft.filters.subscribedCreators === false });
                else cycleOrPick('creator', id);
              }}
            />
            <AddPickRow kind="creator" onAdd={(pick) => addPick('creator', pick)} />
            <LevelSlider label="Weigh the chosen creators" value={creatorLevel} onChange={(level) => setFilters({ creatorLevel: level })} />
          </section>
        </>
      )}

      {tab === 'display' && (
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
              {(layout === 'shorts' || layout === 'stream') && (
                <>
                  {layout === 'shorts' && (
                    <Switch
                      checked={draft.options.shortsLoop !== false}
                      onChange={(shortsLoop) => setOptions({ shortsLoop })}
                      label="Loop each short (off = stop when it ends)"
                    />
                  )}
                  <div className="field">
                    <span>
                      Rail buttons <span className="hint">Which ones this page shows</span>
                    </span>
                    <Chips
                      options={SHORT_BUTTONS}
                      selected={draft.options.shortButtons ?? [...DEFAULT_SHORT_BUTTONS]}
                      labels={SHORT_BUTTON_LABELS}
                      onToggle={(button) => setOptions({ shortButtons: toggle(draft.options.shortButtons ?? [...DEFAULT_SHORT_BUTTONS], button as ShortButton) })}
                    />
                  </div>
                  <label className="field">
                    Button size
                    <select
                      value={draft.options.shortsButtonSize ?? 'medium'}
                      onChange={(e) => setOptions({ shortsButtonSize: e.target.value as PageConfig['options']['shortsButtonSize'] })}
                    >
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </label>
                  {layout === 'stream' && (
                    <label className="field">
                      Image height
                      <input
                        type="range"
                        min={10}
                        max={100}
                        step={5}
                        value={draft.options.imageHeight ?? 72}
                        onChange={(e) => setOptions({ imageHeight: Number(e.target.value) })}
                      />
                      <span className="hint">{draft.options.imageHeight ?? 72}% of the screen height</span>
                    </label>
                  )}
                  <label className="field">
                    {layout === 'shorts' ? 'Comments over the short' : 'Comments over the picture'}
                    <select
                      value={draft.options.shortsComments ?? (layout === 'shorts' ? 'cover' : 'shrink')}
                      onChange={(e) => setOptions({ shortsComments: e.target.value as 'cover' | 'shrink' })}
                    >
                      <option value="cover">{layout === 'shorts' ? 'Cover the short' : 'Cover the picture'}</option>
                      <option value="shrink">{layout === 'shorts' ? 'Shrink the short' : 'Shrink the picture'}</option>
                    </select>
                  </label>
                  <label className="field">
                    Comments share of the screen
                    <input
                      type="range"
                      min={10}
                      max={90}
                      step={5}
                      value={draft.options.shortsCommentsSize ?? 50}
                      onChange={(e) => setOptions({ shortsCommentsSize: Number(e.target.value) })}
                    />
                    <span className="hint">{draft.options.shortsCommentsSize ?? 50}% of the screen</span>
                  </label>
                </>
              )}
            </div>
          </div>
        </section>
      )}
      <div className="row" style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        {page.preset && (
          <button className="small" onClick={handleReset}>
            <RotateCcw size={14} /> Reset all settings to preset
          </button>
        )}
        {!isNew && !page.preset && (
          <button className="small danger" onClick={remove}>
            <Trash2 size={14} /> Delete page
          </button>
        )}
      </div>
    </Modal>
  );
}