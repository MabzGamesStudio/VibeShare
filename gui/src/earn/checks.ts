// The checks behind the "does this step hold?" buttons of the provider-jobs wizard, plus
// the offer helper both tabs use. Reachability goes through the client daemon (no CORS in
// the way); the write test talks to the platform API from the browser, which allows it.
import { sha1hex } from '../../../src/shared/crypto';
import { api } from '../api';
import { contentPath, contentUrl, DUMMY_CID, type HostConfig, type HostingField } from './hosting';

export interface CheckResult {
  ok: boolean;
  message: string;
}

/** The answer to one HEAD (or ranged GET) request the daemon made for us. */
export interface ProbeAnswer {
  ok: boolean;
  status: number;
  bytes: number;
  type: string;
  error?: string;
  ms?: number;
}

/** Asks the client daemon whether an address answers, and with what status. */
export async function probe(url: string): Promise<ProbeAnswer> {
  try {
    return await api<ProbeAnswer>(`/api/probe?url=${encodeURIComponent(url)}`);
  } catch (error) {
    return { ok: false, status: 0, bytes: 0, type: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/** The site answers 200: the base URL a provider queries is publicly reachable. */
export async function checkSite(baseUrl: string): Promise<CheckResult> {
  const url = baseUrl.trim().replace(/\/+$/, '/');
  if (!/^https?:\/\//.test(url)) return { ok: false, message: 'There is no base URL yet — fill in the fields first.' };
  const answer = await probe(url);
  if (answer.error) return { ok: false, message: `Could not reach ${url} — ${answer.error}` };
  if (answer.status === 200) {
    return { ok: true, message: `✓ ${url} answered 200${answer.bytes ? ` (${answer.bytes} bytes)` : ''} in ${answer.ms ?? 0} ms — publicly reachable.` };
  }
  return { ok: false, message: `${url} answered ${answer.status || 'nothing'} — a provider needs a 200 here.` };
}

/** Every content id this panel knows about returns its bytes from the base URL. */
export async function checkCids(baseUrl: string, cids: string[]): Promise<CheckResult> {
  const list = [...new Set(cids.map((cid) => cid.trim()).filter(Boolean))];
  if (!list.length) return { ok: false, message: 'No content id yet — fetch one from a provider job or paste one first.' };
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, message: 'There is no base URL yet — fill in the fields first.' };
  const lines: string[] = [];
  let all = true;
  for (const cid of list.slice(0, 5)) {
    const answer = await probe(contentUrl(baseUrl, cid));
    const short = `${cid.slice(0, 14)}…`;
    if (answer.error) {
      all = false;
      lines.push(`${short} could not be reached (${answer.error})`);
    } else if (answer.status === 200 && answer.bytes > 0) {
      lines.push(`${short} → 200 · ${answer.bytes} bytes${answer.type ? ` · ${answer.type}` : ''}`);
    } else {
      all = false;
      lines.push(`${short} → ${answer.status || 'no answer'}`);
    }
  }
  if (list.length > 5) lines.push(`(+${list.length - 5} more not checked)`);
  return { ok: all, message: `${all ? '✓' : '✗'} ${list.length} content id${list.length === 1 ? '' : 's'}: ${lines.join(' · ')}` };
}

/**
 * The access token can really write: a probe file is committed and removed again. Wired
 * for the two platforms whose pipelines are wired; the rest say so plainly.
 */
export async function checkAccess(platformId: string, values: Record<string, string>): Promise<CheckResult> {
  const name = '.vibeshare-write-test.txt';
  const text = `VibeShare write test ${new Date().toISOString()}`;
  const headers = (token: string) => ({ 'content-type': 'application/json', accept: 'application/json', ...authHeader(platformId, token) });
  if (platformId === 'gitlab') {
    const { namespace, project, branch, token } = values;
    if (!namespace || !project || !token) return { ok: false, message: 'Fill in the user or group, project and access token first.' };
    const file = `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${namespace}/${project}`)}/repository/files/${encodeURIComponent(name)}`;
    const ref = (branch || 'main').trim();
    try {
      const seen = await fetch(`${file}?ref=${encodeURIComponent(ref)}`, { headers: headers(token) });
      const write = await fetch(file, {
        method: seen.ok ? 'PUT' : 'POST',
        headers: headers(token),
        body: JSON.stringify({ branch: ref, content: text, commit_message: 'VibeShare: write test' }),
      });
      if (!write.ok) return { ok: false, message: `GitLab would not write the probe file (${write.status}) — check the token's api scope on this project.` };
      const remove = await fetch(file, { method: 'DELETE', headers: headers(token), body: JSON.stringify({ branch: ref, commit_message: 'VibeShare: write test done' }) });
      return remove.ok
        ? { ok: true, message: `✓ The token wrote ${name} and removed it again — write access works.` }
        : { ok: true, message: `✓ The token wrote ${name} (removing it answered ${remove.status} — delete it by hand in the repository).` };
    } catch (error) {
      return { ok: false, message: `Could not reach gitlab.com to test the token (${error instanceof Error ? error.message : String(error)}).` };
    }
  }
  if (platformId === 'github') {
    const { owner, repo, branch, token } = values;
    if (!owner || !repo || !token) return { ok: false, message: 'Fill in the user or organization, repository and access token first.' };
    const file = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(name)}`;
    try {
      const write = await fetch(file, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({ message: 'VibeShare: write test', content: btoa(text), branch: (branch || 'main').trim() }),
      });
      const body = (await write.json().catch(() => ({}))) as { content?: { sha?: string }; message?: string };
      if (!write.ok) return { ok: false, message: `GitHub would not write the probe file (${write.status}) — ${body.message ?? 'check the Contents: Read and write permission'}.` };
      const remove = await fetch(file, {
        method: 'DELETE',
        headers: headers(token),
        body: JSON.stringify({ message: 'VibeShare: write test done', branch: (branch || 'main').trim(), sha: body.content?.sha }),
      });
      return remove.ok
        ? { ok: true, message: `✓ The token wrote ${name} and removed it again — write access works.` }
        : { ok: true, message: `✓ The token wrote ${name} (removing it answered ${remove.status} — delete it by hand in the repository).` };
    } catch (error) {
      return { ok: false, message: `Could not reach api.github.com to test the token (${error instanceof Error ? error.message : String(error)}).` };
    }
  }
  if (platformId === 'netlify') {
    const { site, token } = values;
    if (!site || !token) return { ok: false, message: 'Fill in the project name and access token first.' };
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const path = contentPath(values, name);
    try {
      // Resolve the project by name (its subdomain) to its site id.
      const list = await fetch('https://api.netlify.com/api/v1/sites', { headers });
      if (list.status === 401) return { ok: false, message: 'Netlify refused the access token — generate a new one in User settings → Applications.' };
      const sites = (await list.json().catch(() => [])) as { id?: string; subdomain?: string; name?: string }[];
      const match = (sites ?? []).find((entry) => entry.subdomain === site.trim() || entry.name === site.trim());
      if (!match?.id) return { ok: false, message: `Netlify knows no project named ${site} — check the project name field.` };
      // The probe lives in a draft deploy: it is written and removed again without ever
      // going live, so the site keeps everything it already serves. The files map takes
      // SHA-1 sums (that is what Netlify matches its file records against — a SHA-256
      // there answers 422 "no records matched"), and each upload sends its size.
      const created = await fetch(`https://api.netlify.com/api/v1/sites/${match.id}/deploys`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ files: { [path]: sha1hex(text) }, draft: true }),
      });
      const deploy = (await created.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!created.ok || !deploy.id) return { ok: false, message: `Netlify would not write the probe file (${created.status}) — ${deploy.message ?? 'check the token'}.` };
      const upload = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files/${path.split('/').map(encodeURIComponent).join('/')}?size=${encodeURIComponent(String(text.length))}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        body: text,
      });
      if (!upload.ok) return { ok: false, message: `Netlify would not upload the probe file (${upload.status}) — check the token.` };
      const remove = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}`, { method: 'DELETE', headers });
      return remove.ok
        ? { ok: true, message: `✓ The token wrote ${name} and removed it again — write access works.` }
        : { ok: true, message: `✓ The token wrote ${name} (removing it answered ${remove.status} — delete the draft deploy by hand in Deploys).` };
    } catch (error) {
      return { ok: false, message: `Could not reach api.netlify.com to test the token (${error instanceof Error ? error.message : String(error)}).` };
    }
  }
  return { ok: false, message: 'No write test is wired for this platform yet — paste the access token by hand and check it on the platform.' };
}

/**
 * The panel-3 check: everything the base URL and the content path are built from is
 * filled in — project name, path, base URL, content id, access token. When the content
 * id is the only thing missing, the answer points at the default article's id below.
 */
export function checkFilled(fields: HostingField[], values: Record<string, string>, baseUrl: string, cid: string): CheckResult {
  const missing = fields.filter((field) => !(values[field.id] ?? '').trim()).map((field) => field.label);
  if (!baseUrl.trim()) missing.push('Base URL');
  const noCid = !cid.trim();
  if (noCid) missing.push('Content id');
  if (!missing.length) {
    return { ok: true, message: '✓ Project name, path, base URL, content id and access token are all filled in.' };
  }
  const hint = noCid
    ? ` No content id yet? Use the one below (${DUMMY_CID.slice(0, 14)}…) — it is the default article describing VibeShare, stored in this app so you never have to find one.`
    : '';
  return { ok: false, message: `✗ Still to fill in: ${missing.join(', ')}.${hint}` };
}

/** The platform's own way of carrying a token in a header. */
function authHeader(platformId: string, token: string): Record<string, string> {
  if (platformId === 'gitlab') return { 'PRIVATE-TOKEN': token };
  if (platformId === 'github') return { authorization: `Bearer ${token}` };
  return {};
}

/** A base URL as a key, so the same address never counts twice. */
export function baseKey(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * Offers a host's base URL to every provider node that does not already have it — the list
 * on the node is asked first, so the same base URL is never offered twice.
 */
export async function offerHost(providers: { id: string; name: string }[], host: HostConfig): Promise<string> {
  const offered: string[] = [];
  for (const node of providers) {
    try {
      const existing = await api<{ items: { baseUrl?: string }[] }>(`/api/nodes/${node.id}/content-urls`);
      if (new Set((existing.items ?? []).map((item) => baseKey(item.baseUrl ?? ''))).has(baseKey(host.baseUrl))) continue;
      await api(`/api/nodes/${node.id}/content-urls`, { method: 'POST', body: { items: [{ baseUrl: host.baseUrl }] } });
      offered.push(node.name);
    } catch {
      // A node that will not take the offer is left out rather than failing the rest.
    }
  }
  return offered.join(', ');
}
