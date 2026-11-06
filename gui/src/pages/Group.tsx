import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { GroupView } from '../../../src/shared/clientapi';
import type { CreatorInfo, GroupSuggestion, GroupSuggestionResponse } from '../../../src/shared/protocol';
import { CREATOR_KIND_LABELS } from '../../../src/shared/taxonomy';
import { api, errorMessage } from '../api';
import { GridLayout } from '../components/feed/Cards';
import { CARD_PAGE } from '../components/Feed';
import { Avatar, CopyButton, Empty, Loading, Modal } from '../components/ui';
import { useApp } from '../state';
import { creatorPath, groupPath } from '../util';

/**
 * The members of the group, in a carousel: every one of them opens on its own creator
 * page. Membership is binary — being in the group says nothing about the member's page.
 */
function MemberCarousel({ members, groupName }: { members: CreatorInfo[]; groupName: string }) {
  if (!members.length) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="hint" style={{ marginBottom: 6 }}>
        Creators in {groupName}
      </div>
      <div className="carousel">
        {members.map((member) => (
          <Link key={member.id} to={creatorPath(member.id)} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="card carousel-card">
              <Avatar name={member.name} id={member.id} icon={member.icon} />
              <div className="carousel-handle" title={member.name}>
                {member.name}
              </div>
              <div className="carousel-line">{CREATOR_KIND_LABELS[member.kind]}</div>
              <div className="carousel-line">{member.description ?? 'On VibeShare'}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * Suggesting changes to a group: which creators to add or drop, and what the name,
 * description, links or icon should be. The node's operator reviews every suggestion.
 */
function SuggestGroup({ group, nodeId, onSaved }: { group: CreatorInfo; nodeId: string; onSaved: () => void }) {
  const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [links, setLinks] = useState('');
  const [reason, setReason] = useState('');
  const [icon, setIcon] = useState<string | undefined>();
  const [mine, setMine] = useState<GroupSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const members = group.members ?? [];

  const load = useCallback(() => {
    api<{ suggestions: GroupSuggestion[] }>(`/api/groups/suggestions/${encodeURIComponent(nodeId)}`)
      .then((result) => setMine(result.suggestions.filter((s) => s.groupId === group.id)))
      .catch(() => setMine([]));
  }, [nodeId, group.id]);
  useEffect(load, [load]);

  const pickIcon = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIcon(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  };

  const list = (text: string) => text.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api<GroupSuggestionResponse>('/api/groups/suggestions', {
        body: {
          nodeId,
          group: group.id,
          add: list(add),
          remove: remove ? [remove] : [],
          name: name.trim() || undefined,
          description: description.trim() || undefined,
          links: list(links),
          icon,
          reason: reason.trim() || undefined,
        },
      });
      toast(result.newInfo ? 'Suggested — the operator reviews it' : 'This is already waiting', 'success');
      setAdd('');
      setRemove('');
      setName('');
      setDescription('');
      setLinks('');
      setReason('');
      setIcon(undefined);
      setOpen(false);
      load();
      onSaved();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form-stack">
      <div className="row between">
        <h3>Suggest a change to {group.name}</h3>
        <button className="small" onClick={() => setOpen(true)}>
          + Suggest change
        </button>
      </div>
      <span className="hint">
        Suggest which creators join or leave the group, or a new name, description, links or group image. One suggestion
        carries everything you fill in; the operator accepts or drops it.
      </span>
      {open && (
        <Modal title={`Suggest a change to ${group.name}`} onClose={() => setOpen(false)}>
          <div className="form-stack">
            <label className="field">
              Creators to add
              <input
                type="text"
                placeholder="Creator ids, separated by spaces (name:labs yt:abcdef…)"
                value={add}
                onChange={(e) => setAdd(e.target.value)}
              />
            </label>
            {members.length > 0 && (
              <label className="field">
                Creator to remove
                <select value={remove} onChange={(e) => setRemove(e.target.value)}>
                  <option value="">Nobody</option>
                  {members.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Group name
              <input type="text" placeholder={group.name} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              Description
              <textarea
                rows={3}
                placeholder={group.description ?? 'What the group collects'}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="field">
              Links
              <input type="text" placeholder="https://… one per line or space" value={links} onChange={(e) => setLinks(e.target.value)} />
            </label>
            <label className="field">
              Group image
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => pickIcon(e.target.files?.[0])} />
            </label>
            {icon && (
              <div className="row">
                <Avatar name={group.name} id={group.id} icon={icon} />
                <span className="hint">This is the group image you suggest.</span>
              </div>
            )}
            <label className="field">
              Why
              <input type="text" placeholder="Optional: where you saw it" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => void submit()}>
                {busy ? 'Sending…' : 'Send suggestion'}
              </button>
              <button onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
      {mine.length > 0 && (
        <div className="page-list">
          {mine.map((suggestion) => (
            <div key={suggestion.id} className="page-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                {[
                  suggestion.name ? `name → ${suggestion.name}` : '',
                  suggestion.description ? 'description' : '',
                  suggestion.links?.length ? `${suggestion.links.length} link(s)` : '',
                  suggestion.icon ? 'image' : '',
                  suggestion.add?.length ? `+ ${suggestion.add.join(', ')}` : '',
                  suggestion.remove?.length ? `− ${suggestion.remove.join(', ')}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <span className={`badge ${suggestion.status === 'accepted' ? 'ok' : ''}`}>
                {suggestion.status === 'accepted' ? 'accepted' : suggestion.status === 'rejected' ? 'dropped' : 'waiting for the operator'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A group page: what a creator page shows, plus its members and their content together. */
export function GroupPage() {
  const { id = '' } = useParams();
  const { state, refresh, toast } = useApp();
  const [view, setView] = useState<GroupView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<GroupView>(`/api/groups/${encodeURIComponent(id)}`)
      .then(setView)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(() => {
    setView(null);
    setError(null);
    load();
  }, [load]);

  if (error) {
    return (
      <div className="page">
        <div className="banner danger">{error}</div>
      </div>
    );
  }
  if (!view || !state) {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }
  const { group } = view;
  const subscribed = state.subscriptions.some((s) => s.id === group.id);

  const toggle = async () => {
    try {
      if (subscribed) await api(`/api/subscriptions/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
      else await api('/api/subscriptions', { body: { id: group.id, name: group.name, kind: 'group' } });
      await refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ gap: 20, marginBottom: 12, alignItems: 'flex-start' }}>
        <Avatar name={group.name} id={group.id} large icon={group.icon} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>
            <Link to={groupPath(group.id)} className="link">
              {group.name}
            </Link>
          </h1>
          <div className="row small muted" style={{ marginTop: 6 }}>
            <span className="badge">Group</span>
            <span>
              {view.members.length} creator{view.members.length === 1 ? '' : 's'}
            </span>
            <span>
              {view.items.length} item{view.items.length === 1 ? '' : 's'}
            </span>
          </div>
          {group.description && (
            <p className="muted" style={{ marginTop: 10 }}>
              {group.description}
            </p>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className={subscribed ? '' : 'primary'} onClick={toggle}>
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </button>
            <CopyButton text={group.id} label="Copy group id" small={false} />
          </div>
        </div>
      </div>
      <MemberCarousel members={view.members} groupName={group.name} />
      {view.via && <SuggestGroup group={group} nodeId={view.via} onSaved={load} />}
      {view.items.length ? (
        <GridLayout items={view.items} page={CARD_PAGE} />
      ) : (
        <Empty title="No content yet">
          <p>None of the creators in this group has content listed on your algorithm nodes.</p>
        </Empty>
      )}
    </div>
  );
}


