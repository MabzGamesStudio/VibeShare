import { useCallback, useEffect, useState } from 'react';
import type { CreatorInfo, GroupSuggestion, TopicInfo, TopicSuggestion } from '../../../src/shared/protocol';
import { CopyButton, Loading, Modal } from '../components/ui';
import { timeAgo } from '../util';
import { admin, message } from './api';
import { useToast } from './AdminApp';

/** A group as the console sees it: the creator record, its members and what they bring. */
interface GroupRow {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  status: 'listed' | 'blocked';
  addedAt: string;
  members?: string[];
  memberCreators?: CreatorInfo[];
  items: number;
}

/** A suggested change to a group, with the member ids resolved to names. */
interface GroupSuggestionRow extends GroupSuggestion {
  addNames?: string[];
  removeNames?: string[];
}

/** Adding and dropping members: membership is binary, there is no linking between creators. */
function MemberEditor({ group, onChanged }: { group: GroupRow; onChanged: () => void }) {
  const [, show] = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CreatorInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const members = group.memberCreators ?? [];

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults([]);
      return;
    }
    let live = true;
    admin<{ creators: CreatorInfo[] }>(`/v1/admin/creators?q=${encodeURIComponent(text)}&limit=8`)
      .then((result) => {
        if (live) setResults(result.creators.filter((creator) => creator.kind !== 'group' && !members.some((member) => member.id === creator.id)));
      })
      .catch(() => live && setResults([]));
    return () => {
      live = false;
    };
  }, [query, members]);

  const change = async (add: string[], remove: string[]) => {
    setBusy(true);
    try {
      await admin(`/v1/admin/groups/${encodeURIComponent(group.id)}/members`, { method: 'POST', body: { add, remove } });
      setQuery('');
      onChanged();
    } catch (error) {
      show(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-stack" style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="hint">Members</span>
        {members.map((member) => (
          <button
            key={member.id}
            className="badge ok"
            disabled={busy}
            title={`Remove ${member.name} from the group`}
            onClick={() => void change([], [member.id])}
          >
            {member.name} ×
          </button>
        ))}
        {!members.length && <span className="faint small">No creators in this group yet.</span>}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <input type="text" placeholder="Search a creator to add" value={query} style={{ maxWidth: 260 }} onChange={(e) => setQuery(e.target.value)} />
        {results.map((creator) => (
          <button key={creator.id} className="small" disabled={busy} onClick={() => void change([creator.id], [])}>
            + {creator.name}
          </button>
        ))}
        {query.trim() && !results.length && <span className="faint small">No creator matches (groups cannot join groups).</span>}
      </div>
    </div>
  );
}

/** Group suggestions clients made, waiting for the operator. */
function GroupReview({ onReviewed }: { onReviewed: () => void }) {
  const [, show] = useToast();
  const [rows, setRows] = useState<GroupSuggestionRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    admin<{ suggestions: GroupSuggestionRow[] }>('/v1/admin/group-suggestions')
      .then((result) => setRows(result.suggestions))
      .catch((error) => {
        setRows([]);
        show(message(error));
      });
  }, [show]);
  useEffect(load, [load]);

  const act = async (id: string, action: 'accept' | 'delete') => {
    setBusy(true);
    try {
      await admin(`/v1/admin/group-suggestions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      show(action === 'accept' ? 'Applied' : 'Dropped');
      load();
      onReviewed();
    } catch (error) {
      show(message(error));
    } finally {
      setBusy(false);
    }
  };

  if (!rows) return <Loading />;
  if (!rows.length) return <p className="hint">No suggested group changes are waiting.</p>;
  return (
    <div className="page-list">
      {rows.map((row) => (
        <div key={row.id} className="card form-stack">
          <div className="row between">
            <div>
              <strong>{row.groupName ?? row.groupId}</strong>
              <div className="tiny faint">
                {timeAgo(row.createdAt)} · {row.accountId.slice(0, 12)}
                {row.reason ? ` · “${row.reason}”` : ''}
              </div>
            </div>
            <div className="row">
              <button className="primary small" disabled={busy} onClick={() => void act(row.id, 'accept')}>
                Accept
              </button>
              <button className="small danger" disabled={busy} onClick={() => void act(row.id, 'delete')}>
                Delete
              </button>
            </div>
          </div>
          <div className="small">
            {[
              row.name ? `name → ${row.name}` : '',
              row.description ? `description → ${row.description}` : '',
              row.links?.length ? `links → ${row.links.join(', ')}` : '',
              row.add?.length ? `add → ${(row.addNames ?? row.add).join(', ')}` : '',
              row.remove?.length ? `remove → ${(row.removeNames ?? row.remove).join(', ')}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {row.icon && <img style={{ maxWidth: 96, borderRadius: 8 }} src={row.icon} alt="Suggested group image" />}
        </div>
      ))}
    </div>
  );
}


/**
 * Groups: a list of existing content creators, kept as a creator of kind `group`. The
 * operator makes them, says who is in them, and decides on the changes clients suggest.
 */
export function Groups() {
  const [, show] = useToast();
  const [groups, setGroups] = useState<GroupRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<{ id: string; name: string; description: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    admin<{ groups: GroupRow[] }>(`/v1/admin/groups?q=${encodeURIComponent(query)}`)
      .then((result) => setGroups(result.groups))
      .catch((error) => {
        setGroups([]);
        show(message(error));
      });
  }, [query, show]);
  useEffect(load, [load]);

  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await admin('/v1/admin/groups', { method: 'PUT', body });
      show('Saved');
      setCreating(null);
      load();
    } catch (error) {
      show(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <input type="text" placeholder="Search groups by name or id" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 320 }} />
        <button className="primary small" onClick={() => setCreating({ id: '', name: '', description: '' })}>
          + New group
        </button>
      </div>
      <h2 style={{ marginBottom: 8 }}>Waiting for review</h2>
      <GroupReview onReviewed={load} />
      <h2 style={{ margin: '20px 0 8px' }}>Groups</h2>
      {!groups ? (
        <Loading />
      ) : !groups.length ? (
        <p className="hint">No group yet. A group is a list of content creators; its page shows them in a carousel and their content together.</p>
      ) : (
        <div className="page-list">
          {groups.map((group) => (
            <details key={group.id} className="card" style={{ padding: 12 }}>
              <summary className="row between" style={{ cursor: 'pointer' }}>
                <div className="row" style={{ gap: 10, minWidth: 0 }}>
                  {group.icon ? <img src={group.icon} alt="" style={{ width: 32, height: 32, borderRadius: 16, objectFit: 'cover' }} /> : null}
                  <div style={{ minWidth: 0 }}>
                    <strong>{group.name}</strong>
                    <div className="tiny faint">
                      {group.id} · {(group.members ?? []).length} creator{(group.members ?? []).length === 1 ? '' : 's'} · {group.items} item
                      {group.items === 1 ? '' : 's'}
                      {group.status === 'blocked' ? ' · blocked' : ''}
                    </div>
                  </div>
                </div>
                <span className="faint small">since {timeAgo(group.addedAt)}</span>
              </summary>
              <MemberEditor group={group} onChanged={load} />
              <div className="form-stack" style={{ marginTop: 10 }}>
                <label className="field">
                  Name
                  <input
                    type="text"
                    key={`name-${group.id}-${group.name}`}
                    defaultValue={group.name}
                    onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== group.name && void save({ id: group.id, name: e.target.value.trim() })}
                  />
                </label>
                <label className="field">
                  Description
                  <textarea
                    rows={2}
                    key={`desc-${group.id}-${group.description ?? ''}`}
                    defaultValue={group.description ?? ''}
                    onBlur={(e) => e.target.value !== (group.description ?? '') && void save({ id: group.id, description: e.target.value })}
                  />
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <CopyButton text={group.id} label="Copy group id" />
                  <button
                    className={group.status === 'blocked' ? 'small' : 'small danger'}
                    disabled={busy}
                    onClick={() => void save({ id: group.id, status: group.status === 'blocked' ? 'listed' : 'blocked' })}
                  >
                    {group.status === 'blocked' ? 'Unblock' : 'Block'}
                  </button>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => void save({ id: group.id, icon: String(reader.result ?? '') });
                      reader.readAsDataURL(file);
                    }}
                  />
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
      {creating && (
        <Modal title="New group" onClose={() => setCreating(null)}>
          <div className="form-stack">
            <label className="field">
              Id <span className="hint">Like a creator id: name:labs, or a link id such as yt:abcdef01234</span>
              <input type="text" value={creating.id} onChange={(e) => setCreating({ ...creating, id: e.target.value })} placeholder="name:nightly" />
            </label>
            <label className="field">
              Name
              <input type="text" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="Nightly creators" />
            </label>
            <label className="field">
              Description
              <textarea rows={3} value={creating.description} onChange={(e) => setCreating({ ...creating, description: e.target.value })} />
            </label>
            <span className="hint">Add the creators it collects afterwards, from the group's own row.</span>
            <div className="row">
              <button
                className="primary"
                disabled={busy || !creating.id.trim() || !creating.name.trim()}
                onClick={() => void save({ id: creating.id.trim(), name: creating.name.trim(), description: creating.description })}
              >
                Create group
              </button>
              <button onClick={() => setCreating(null)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Topics: a category of content, kept under the hash of its name. */
export function Topics() {
  const [, show] = useToast();
  const [topics, setTopics] = useState<TopicInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<TopicSuggestion[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; name: string; description: string; status: 'listed' | 'blocked' } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    admin<{ topics: TopicInfo[] }>(`/v1/admin/topics?q=${encodeURIComponent(query)}`)
      .then((result) => setTopics(result.topics))
      .catch((error) => {
        setTopics([]);
        show(message(error));
      });
  }, [query, show]);
  const loadSuggestions = useCallback(() => {
    admin<{ suggestions: TopicSuggestion[] }>('/v1/admin/topic-suggestions')
      .then((result) => setSuggestions(result.suggestions))
      .catch(() => setSuggestions([]));
  }, []);
  useEffect(load, [load]);
  useEffect(loadSuggestions, [loadSuggestions]);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await admin('/v1/admin/topics', {
        method: 'PUT',
        body: { id: editing.id, name: editing.name, description: editing.description, status: editing.status },
      });
      show('Saved');
      setEditing(null);
      load();
    } catch (error) {
      show(message(error));
    } finally {
      setBusy(false);
    }
  };

  const review = async (id: string, action: 'accept' | 'delete') => {
    setBusy(true);
    try {
      await admin(`/v1/admin/topic-suggestions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      show(action === 'accept' ? 'Applied' : 'Dropped');
      loadSuggestions();
      load();
    } catch (error) {
      show(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <input type="text" placeholder="Search topics by name or id" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 320 }} />
        <button className="primary small" onClick={() => setEditing({ name: '', description: '', status: 'listed' })}>
          + New topic
        </button>
      </div>
      <h2 style={{ marginBottom: 8 }}>Descriptions and icons waiting</h2>
      {!suggestions ? (
        <Loading />
      ) : !suggestions.length ? (
        <p className="hint">Nothing waiting.</p>
      ) : (
        <div className="page-list">
          {suggestions.map((suggestion) => (
            <div key={suggestion.id} className="card form-stack">
              <div className="row between">
                <div>
                  <strong>{suggestion.topicName ?? suggestion.topicId}</strong>
                  <div className="tiny faint">
                    {timeAgo(suggestion.createdAt)} · {suggestion.accountId.slice(0, 12)}
                    {suggestion.reason ? ` · “${suggestion.reason}”` : ''}
                  </div>
                </div>
                <div className="row">
                  <button className="primary small" disabled={busy} onClick={() => void review(suggestion.id, 'accept')}>
                    Accept
                  </button>
                  <button className="small danger" disabled={busy} onClick={() => void review(suggestion.id, 'delete')}>
                    Delete
                  </button>
                </div>
              </div>
              {suggestion.description && <div className="small">description → {suggestion.description}</div>}
              {suggestion.icon && <img src={suggestion.icon} alt="Suggested topic icon" style={{ maxWidth: 96, borderRadius: 8 }} />}
            </div>
          ))}
        </div>
      )}
      <TopicsTable
        topics={topics}
        onEdit={(topic) => setEditing({ id: topic.id, name: topic.name, description: topic.description ?? '', status: 'listed' })}
      />
      {editing && (
        <Modal title={editing.id ? `Topic ${editing.name}` : 'New topic'} onClose={() => setEditing(null)}>
          <div className="form-stack">
            <label className="field">
              Name
              <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Science" />
            </label>
            <label className="field">
              Description
              <textarea rows={3} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            {editing.id ? (
              <>
                <span className="hint">Its id is the hash of the name it was made with; content carries it, so it never changes.</span>
                <label className="field">
                  State
                  <select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as 'listed' | 'blocked' })}>
                    <option value="listed">Listed</option>
                    <option value="blocked">Blocked</option>
                  </select>
                </label>
              </>
            ) : (
              <span className="hint">The id follows from the name: every node and client asking for this name lands on the same topic.</span>
            )}
            <div className="row">
              <button className="primary" disabled={busy || !editing.name.trim()} onClick={() => void save()}>
                Save
              </button>
              <button onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** The topics themselves: name, id, how much content carries the id, and an edit button. */
function TopicsTable({ topics, onEdit }: { topics: TopicInfo[] | null; onEdit: (topic: TopicInfo) => void }) {
  if (!topics) return <Loading />;
  if (!topics.length) {
    return <p className="hint">No topic yet: clients bring them, content carries them (topic ids), and this is where they are named and described.</p>;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Topic</th>
          <th>Id</th>
          <th>Items</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {topics.map((topic) => (
          <tr key={topic.id}>
            <td>
              <div className="row" style={{ gap: 8 }}>
                {topic.icon ? <img src={topic.icon} alt="" style={{ width: 24, height: 24, borderRadius: 6, objectFit: 'cover' }} /> : null}
                <div>
                  <strong>{topic.name}</strong>
                  {topic.description && <div className="tiny faint">{topic.description}</div>}
                </div>
              </div>
            </td>
            <td className="mono tiny">{topic.id}</td>
            <td>{topic.items ?? 0}</td>
            <td>
              <button className="small" onClick={() => onEdit(topic)}>
                Edit
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}


