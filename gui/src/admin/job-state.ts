// The two tags every storage job shows, derived the same way everywhere.
//
// 1. availability — open while copies can still be filled, closed when every slot is taken;
// 2. outcome — success when every copy is working, partial failure when some are, failure
//    when none is.
//
// "Working" means the copy is really reachable: the holder is active, or its offered URL
// has served the content (a link's fail count was cleared by the last good check). The
// Storage jobs panel, the content details tab and the modal all use these functions so
// their numbers and tags can never disagree.

export interface JobHolderState {
  status: string;
  links?: { fails?: number }[];
}

export interface JobTag {
  label: string;
  tone: string;
}

export interface JobTags {
  /** Copies that are reachable right now. */
  working: number;
  availability: JobTag;
  outcome: JobTag;
}

/** A URL that has no failures on record has served the content (a good check clears it). */
export function linkServes(link: { fails?: number }): boolean {
  return (link.fails ?? 0) === 0;
}

/** One holder's state in words: active, downloading, removed — or failed when nothing serves. */
export function holderState(holder: JobHolderState): JobTag {
  const serving = (holder.links ?? []).some(linkServes);
  if (holder.status === 'active') return { label: 'active', tone: 'ok' };
  if (holder.status === 'downloading') return serving ? { label: 'active', tone: 'ok' } : { label: 'downloading', tone: '' };
  if (holder.status === 'removed' || holder.status === 'failed') return { label: 'failed', tone: 'danger' };
  return { label: holder.status, tone: '' };
}

/** Copies that count as fulfilled: active holders and holders whose URL already serves. */
export function workingHolders(holders: JobHolderState[]): number {
  return holders.filter((holder) => holderState(holder).label === 'active').length;
}

/** Slots still fillable: every copy the plan wants that no live holder takes. A holder the
 * node dropped (removed/failed) or one that gave the job back (released) frees its copy. */
export function freeSlots(holders: JobHolderState[], wanted: number): number {
  const taken = holders.filter((holder) => holder.status === 'active' || holder.status === 'downloading').length;
  return Math.max(0, wanted - taken);
}

/**
 * The two tags for a job. `wanted` is the number of copies the plan asks for (tier copies
 * plus URL backups, or the job's replicas when no tier is assigned).
 */
export function jobTags(holders: JobHolderState[], wanted: number): JobTags {
  return jobTagsFromCounts(workingHolders(holders), wanted, freeSlots(holders, wanted));
}

/** The same tags from the counts the admin list already has (it does not ship the links). */
export function jobTagsFromCounts(working: number, wanted: number, free: number): JobTags {
  const open = free > 0;
  return {
    working,
    availability: open ? { label: 'open', tone: 'accent' } : { label: 'closed', tone: '' },
    outcome:
      working === 0
        ? { label: 'failed', tone: 'danger' }
        : working >= wanted
          ? { label: 'success', tone: 'ok' }
          : { label: 'partial failure', tone: 'warn' },
  };
}

/** The long form used on the job's own header: "storage job successful" and friends. */
export function jobOutcomeLong(tags: JobTags): JobTag {
  return { label: `storage job ${tags.outcome.label}`, tone: tags.outcome.tone };
}
