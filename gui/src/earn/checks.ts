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
  /** Set when the local client refused or could not make the probe: the site was never asked. */
  local?: true;
  ms?: number;
}

/** Asks the client daemon whether an address answers, and with what status. */
export async function probe(url: string): Promise<ProbeAnswer> {
  try {
    return await api<ProbeAnswer>(`/api/probe?url=${encodeURIComponent(url)}`);
  } catch (error) {
    // Not the site's answer: the local client refused the call (its own access token) or
    // is unreachable. Keep that apart — a working site must never look down because the
    // app's own connection failed.
    return { ok: false, status: 0, bytes: 0, type: '', error: error instanceof Error ? error.message : String(error), local: true };
  }
}

/** When the local client itself failed, the honest message names it — not the site. */
function localRefused(url: string, error: string): string {
  return `The site was not asked at all — the local VibeShare client refused or could not run this check (${error}). This is about the app's own connection to its local client (its local access token), not about ${url}. Open the GUI from the VibeShare client — or restart it — and try again.`;
}

/** The site answers 200: the base URL a provider queries is publicly reachable. */
export async function checkSite(baseUrl: string): Promise<CheckResult> {
  const url = baseUrl.trim().replace(/\/+$/, '/');
  if (!/^https?:\/\//.test(url)) return { ok: false, message: 'There is no base URL yet — fill in the fields first.' };
  const answer = await probe(url);
  if (answer.error) return { ok: false, message: answer.local ? localRefused(url, answer.error) : `Could not reach ${url} — ${answer.error}` };
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
    const url = contentUrl(baseUrl, cid);
    const answer = await probe(url);
    const short = `${cid.slice(0, 14)}…`;
    if (answer.local) return { ok: false, message: localRefused(url, answer.error ?? 'no answer') };
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
 * The site answers with an index.html: the page the setup uploads is being served. Only
 * the address is used — no account, no access token: step 1 is about the site existing.
 * `alternates` holds the platform's other valid addresses for the same site (GitLab
 * serves one project under its project-site and its unique-domain shape); any one of
 * them counts, and `onMatched` names the one that answered so the caller can keep it.
 */
export async function checkIndex(baseUrl: string, alternates: string[] = [], onMatched?: (root: string) => void): Promise<CheckResult> {
  const roots = [...new Set([baseUrl, ...alternates].map((url) => url.trim().replace(/\/+$/, '/')).filter((url) => /^https?:\/\//.test(url)))];
  if (!roots.length) return { ok: false, message: 'There is no site address yet — fill in the fields first.' };
  const lines: string[] = [];
  for (const root of roots) {
    const url = new URL('index.html', root).href;
    const answer = await probe(url);
    if (answer.local) return { ok: false, message: localRefused(url, answer.error ?? 'no answer') };
    if (answer.error) {
      lines.push(`${url} could not be reached (${answer.error})`);
    } else if (answer.status === 200) {
      onMatched?.(root);
      return { ok: true, message: `✓ index.html is at the hosted URL — ${url} answered 200${answer.bytes ? ` (${answer.bytes} bytes)` : ''} in ${answer.ms ?? 0} ms.` };
    } else {
      lines.push(`${url} answered ${answer.status || 'nothing'}`);
    }
  }
  return { ok: false, message: `No index.html at the hosted URL — ${lines.join(' · ')}. Upload the starter page first.` };
}

/**
 * The "Check URLs" button: probes `<base>/index.html` under every candidate address and
 * names the one that answered 200 (the caller keeps it selected). When none answers yet,
 * the message says to wait — a first deploy can take a few minutes.
 */
export async function checkIndexUrls(candidates: string[]): Promise<CheckResult & { matched?: string }> {
  const roots = [...new Set(candidates.map((url) => url.trim().replace(/\/+$/, '/')).filter((url) => /^https?:\/\//.test(url)))];
  if (!roots.length) return { ok: false, message: 'Fill in the fields first — the site addresses are built from them.' };
  const lines: string[] = [];
  for (const root of roots) {
    const url = new URL('index.html', root).href;
    const answer = await probe(url);
    if (answer.local) return { ok: false, message: localRefused(url, answer.error ?? 'no answer') };
    if (answer.error) {
      lines.push(`${url} could not be reached (${answer.error})`);
    } else if (answer.status === 200) {
      return { ok: true, matched: root, message: `✓ ${url} answered 200 — the site is live at this address.` };
    } else {
      lines.push(`${url} answered ${answer.status || 'nothing'}`);
    }
  }
  return { ok: false, message: `No index.html answered yet (${lines.join(' · ')}). The site may take a few minutes to deploy after the first commit — wait and try again.` };
}

/**
 * The final check: the bytes at `<base>/<cid>` hash to the chosen content id. The client
 * downloads and verifies them through POST /api/content-link — a wrong hash is called
 * out by name, never folded into a generic failure.
 */
export async function checkContentHash(baseUrl: string, cid: string): Promise<CheckResult> {
  const id = cid.trim();
  if (!id) return { ok: false, message: 'No content id yet — fetch one from a provider job or paste one first.' };
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, message: 'There is no base URL yet — fill in the fields first.' };
  const url = contentUrl(baseUrl, id);
  try {
    const answer = await api<{ ok: boolean; size: number; error?: string }>('/api/content-link', { body: { url, cid: id } });
    if (answer.ok) return { ok: true, message: `✓ the bytes at ${url} hash to ${id} (${answer.size} bytes).` };
    if (answer.error && /does not match|match the expected/i.test(answer.error)) {
      return { ok: false, message: `✗ the downloaded bytes at ${url} do not match the content id ${id} (got a different hash).` };
    }
    return { ok: false, message: `✗ could not verify ${url} — ${answer.error ?? 'the download failed'}.` };
  } catch (error) {
    return { ok: false, message: `✗ the check could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The reason a failed platform response carries in its body — GitLab answers
 * {"message":"401 Unauthorized"} (or {"error":…}); others spell it out similarly. Used so
 * a 4xx/5xx always shows the platform's own words beside the status code.
 */
async function responseMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const message = body.message ?? body.error;
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object') {
      return Object.values(message as Record<string, unknown>)
        .flat()
        .filter((part): part is string => typeof part === 'string')
        .join('; ');
    }
  } catch {
    // Not JSON: show the plain-text body instead.
  }
  return text.trim().slice(0, 200);
}

/**
 * The access token can really write: a probe file is committed and removed again. Wired
 * for GitHub, GitLab, Netlify and Vercel; the rest say so plainly. Every failure names
 * the HTTP status and the platform's own error message when it sent one.
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
    /** GitLab's refusal, in full: what it answered and the reason it put in the body. */
    const refused = async (response: Response, doing: string) => {
      const detail = await responseMessage(response);
      return { ok: false, message: `GitLab would not ${doing} (HTTP ${response.status}${detail ? ` — ${detail}` : ''}) — check the token's api scope and the project path.` };
    };
    try {
      const seen = await fetch(`${file}?ref=${encodeURIComponent(ref)}`, { headers: headers(token) });
      const write = await fetch(file, {
        method: seen.ok ? 'PUT' : 'POST',
        headers: headers(token),
        body: JSON.stringify({ branch: ref, content: text, commit_message: 'VibeShare: write test' }),
      });
      if (!write.ok) return refused(write, 'write the probe file');
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
  if (platformId === 'vercel') {
    const { project, token } = values;
    if (!project || !token) return { ok: false, message: 'Fill in the project name and access token first.' };
    try {
      // A preview deployment holding only the probe file: it proves the token can push
      // without touching what the live deployment serves.
      const deploy = await fetch('https://api.vercel.com/v13/deployments?forceNew=1', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: project,
          target: 'preview',
          projectSettings: { framework: null },
          files: [{ file: name, data: btoa(text), encoding: 'base64' }],
        }),
      });
      const body = (await deploy.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!deploy.ok || !body.id) {
        return { ok: false, message: `Vercel would not push the probe file (${deploy.status}) — ${body.error?.message ?? 'check the token and the project name'}.` };
      }
      const remove = await fetch(`https://api.vercel.com/v13/deployments/${encodeURIComponent(body.id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => null);
      return remove?.ok
        ? { ok: true, message: `✓ The token pushed ${name} and removed it again — write access works.` }
        : { ok: true, message: `✓ The token pushed ${name} (a preview deployment, the live site untouched) — write access works.` };
    } catch (error) {
      return { ok: false, message: `Could not reach api.vercel.com to test the token (${error instanceof Error ? error.message : String(error)}).` };
    }
  }
  return { ok: false, message: 'No write test is wired for this platform yet — paste the access token by hand and check it on the platform.' };
}

/**
 * The panel-3 check: everything the base URL and the content path are built from is
 * filled in — project name, path, base URL, content id. Secret fields (the platform
 * access token) and optional ones (only needed for one variant of the address) are never
 * asked for here: the token is step 2's business and the URL checks need none. When the
 * content id is the only thing missing, the answer points at the default article's id
 * below.
 */
export function checkFilled(fields: HostingField[], values: Record<string, string>, baseUrl: string, cid: string): CheckResult {
  const missing = fields.filter((field) => !field.secret && !field.optional && !(values[field.id] ?? '').trim()).map((field) => field.label);
  if (!baseUrl.trim()) missing.push('Base URL');
  const noCid = !cid.trim();
  if (noCid) missing.push('Content id');
  if (!missing.length) {
    return { ok: true, message: '✓ Project name, path, base URL and content id are all filled in.' };
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
