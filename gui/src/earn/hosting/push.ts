// Pushing one content id's bytes to a saved host: every platform's pipeline, wired to
// its own API, with the default a plain message for a platform this build lacks.

import type { HostConfig, PushResult } from './types';
import { contentUrl, contentPath } from './url';
import { STARTER_HTML } from './platforms/shared';
import { loadPushed, savePushed } from './drafts';
import { hostingPlatform } from './platforms';
import { sha1hex } from '../../../../src/shared/crypto';
import { base64Of, bytesFromBase64, gzip, hmacBase64Of, rsaSha256Jwt, sha256HexOf, sigV2, sigV4, tarOf } from '../signing';

/** The short reason out of a failed platform answer, whatever shape it comes in. */
async function failureDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return response.statusText || `status ${response.status}`;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const detail = parsed.error ?? parsed.errors ?? parsed.message ?? parsed.messages;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((entry) => (typeof entry === 'string' ? entry : String((entry as { message?: string })?.message ?? JSON.stringify(entry))))
        .join('; ')
        .slice(0, 300);
    }
    if (detail && typeof detail === 'object') {
      const message = (detail as { message?: string }).message;
      return typeof message === 'string' ? message : JSON.stringify(detail).slice(0, 300);
    }
  } catch {
    // Not JSON — the raw text is the detail.
  }
  return text.slice(0, 300);
}

function toBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Puts one content id into a GitHub repository with the contents API (the worked example). */
async function pushGitHub(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { owner, repo, branch, token } = host.values;
  if (!owner || !repo || !token) return { ok: false, message: 'Fill in the user, repository and access token first.' };
  const path = contentPath(host.values, cid);
  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' };
  // An update needs the file's current sha; a new file does not.
  let sha: string | undefined;
  const existing = await fetch(api, { headers });
  if (existing.ok) sha = ((await existing.json()) as { sha?: string }).sha;
  const response = await fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `Provider job: publish ${cid}`,
      content: toBase64(data),
      branch: branch || 'main',
      ...(sha ? { sha } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { content?: { html_url?: string }; message?: string };
  if (!response.ok) return { ok: false, message: `GitHub refused the push: ${body.message ?? response.statusText}` };
  return { ok: true, message: `Pushed ${cid} to ${host.label} — the site serves it once Pages rebuilds.`, url: body.content?.html_url };
}

/**
 * Commits one content id into a GitLab repository with the files API. Pages publishes the
 * public folder as the site, so the file goes to public/<folder>/<cid> and GitLab serves it
 * at <base>/<cid> about a minute after the commit.
 */
async function pushGitLab(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { namespace, project, branch, token } = host.values;
  if (!namespace || !project || !token) return { ok: false, message: 'Fill in the user or group, project and access token first.' };
  // Pages publishes the public folder as the site root, so the content id lands one
  // level under it: public/<folder>/<cid> in the repository is served at <folder>/<cid> —
  // exactly where the base URL points (<base>/<cid> carries the folder).
  const path = `public/${contentPath(host.values, cid)}`;
  // The whole path goes in encoded: GitLab takes file_path URL-encoded with its slashes
  // included (public%2Fvs1…), so segments are never re-joined with a literal "/".
  const file = encodeURIComponent(path);
  const api = `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${namespace}/${project}`)}/repository/files/${file}`;
  const ref = (branch || 'main').trim();
  const headers = { 'PRIVATE-TOKEN': token, accept: 'application/json', 'content-type': 'application/json' };
  try {
    // An existing file is updated (PUT), a missing one created (POST); both send base64.
    const existing = await fetch(`${api}?ref=${encodeURIComponent(ref)}`, { headers });
    if (existing.status === 401 || existing.status === 403) {
      return { ok: false, message: 'GitLab refused the access token — give it the api scope on this project (Avatar → Edit profile → Access → Personal access tokens).' };
    }
    if (existing.status === 404 && (await existing.json().catch(() => null))?.message === '404 Project Not Found') {
      return { ok: false, message: `GitLab knows no project at ${namespace}/${project} — check the User or group and Project fields.` };
    }
    const response = await fetch(api, {
      method: existing.ok ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify({
        branch: ref,
        content: toBase64(data),
        encoding: 'base64',
        commit_message: `Provider job: publish ${cid}`,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { message?: unknown };
    const url = contentUrl(host.baseUrl, cid);
    if (!response.ok) {
      const detail = typeof body.message === 'string' ? body.message : JSON.stringify(body.message ?? response.statusText);
      // Publishing bytes that are already there is not a failure: the file serves them.
      if (response.status === 400 && /identical|would not be changed/i.test(detail)) {
        return { ok: true, message: `${cid} is already on ${host.label} under that path — nothing to change.`, url };
      }
      return { ok: false, message: `GitLab refused the push: ${detail}` };
    }
    return { ok: true, message: `Pushed ${cid} to ${host.label} — GitLab Pages rebuilds now and serves it at ${url} in about a minute.`, url };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Could not reach gitlab.com (${why}). Check the connection and the token, or commit ${path} by hand in the repository.`,
    };
  }
}

/**
 * Puts one content id on a Netlify site with the deploy files API. A deploy is the whole
 * site, so every file the site currently serves is carried into the new deploy by its
 * SHA-1 (Netlify matches those digests and never asks for those bytes again) and only the
 * new content id is uploaded. The deploy publishes by itself once its files are in.
 */
async function pushNetlify(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { site, token } = host.values;
  if (!site || !token) return { ok: false, message: 'Fill in the project name and access token first.' };
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const path = `/${contentPath(host.values, cid)}`;
  const url = contentUrl(host.baseUrl, cid);
  try {
    // Resolve the project by name (its subdomain) to its site id.
    const list = await fetch('https://api.netlify.com/api/v1/sites', { headers });
    if (list.status === 401) return { ok: false, message: 'Netlify refused the access token — generate a new one in User settings → Applications.' };
    const sites = (await list.json().catch(() => [])) as { id?: string; subdomain?: string; name?: string }[];
    const match = (sites ?? []).find((entry) => entry.subdomain === site.trim() || entry.name === site.trim());
    if (!match?.id) return { ok: false, message: `Netlify knows no project named ${site} — check the project name field.` };
    // Carry the site's current files into the deploy by digest, so a push adds to what is
    // already live instead of replacing it.
    const files: Record<string, string> = {};
    const current = await fetch(`https://api.netlify.com/api/v1/sites/${match.id}/files`, { headers });
    const carried = current.ok ? ((await current.json().catch(() => [])) as { path?: string; sha?: string }[]) : [];
    for (const file of carried ?? []) if (file.path && file.sha) files[file.path] = file.sha;
    files[path] = sha1hex(data);
    const created = await fetch(`https://api.netlify.com/api/v1/sites/${match.id}/deploys`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ files, title: `VibeShare: ${cid}` }),
    });
    const deploy = (await created.json().catch(() => ({}))) as { id?: string; required?: string[]; state?: string; message?: string };
    if (!created.ok || !deploy.id) {
      return { ok: false, message: `Netlify would not create the deploy (${created.status}) — ${deploy.message ?? 'check the token and the project name'}.` };
    }
    // Upload only what Netlify does not already hold: its answer lists exactly what it
    // still needs. A path it wants that this push does not carry cancels the deploy.
    for (const needed of deploy.required ?? []) {
      if (needed.replace(/^\/+/, '') !== path.replace(/^\/+/, '')) {
        await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}`, { method: 'DELETE', headers }).catch(() => undefined);
        return {
          ok: false,
          message: `Netlify asked this deploy for a file the push does not carry (${needed}) — the deploy was cancelled. Push again, or drag the starter folder into Deploys.`,
        };
      }
      const upload = await fetch(
        `https://api.netlify.com/api/v1/deploys/${deploy.id}/files/${path.split('/').map(encodeURIComponent).join('/')}?size=${encodeURIComponent(String(data.length))}`,
        { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: data as unknown as BodyInit }
      );
      if (!upload.ok) return { ok: false, message: `Netlify would not accept the file (${upload.status}) — check the token.` };
    }
    // The deploy publishes by itself once its files are in; report what it reached.
    for (let attempt = 0; attempt < 8; attempt++) {
      const check = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}`, { headers });
      const state = ((await check.json().catch(() => ({}))) as { state?: string }).state;
      if (state === 'ready') return { ok: true, message: `Pushed ${cid} to ${host.label} — the deploy is published and serves it at ${url}.`, url };
      if (state === 'error') {
        return {
          ok: false,
          message: 'Netlify could not process the deploy — check Site configuration → Build & deploy (the build command must be empty, asset optimization off) and the deploy log.',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return {
      ok: true,
      message: `Pushed ${cid} to ${host.label} — Netlify is publishing the deploy; it serves at ${url} once the Deploys list says “Published”.`,
      url,
    };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach api.netlify.com (${why}). Check the connection and the token.` };
  }
}

/**
 * Puts one content id into a Cloudflare Pages project with the direct-upload API: the file
 * goes into the content-addressed asset store (base64, keyed by its SHA-256), and the
 * deployment's manifest names every file the site carries — the ones pushed before are
 * referenced by their hashes, so nothing else has to be uploaded again.
 */
async function pushCloudflare(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { account, project, token } = host.values;
  if (!account || !project || !token) return { ok: false, message: 'Fill in the account id, project name and API token first.' };
  const api = 'https://api.cloudflare.com/client/v4';
  const path = `/${contentPath(host.values, cid)}`;
  const url = contentUrl(host.baseUrl, cid);
  try {
    const issued = await fetch(`${api}/accounts/${account}/pages/projects/${project}/upload-token`, { headers: { authorization: `Bearer ${token}` } });
    const issuedBody = (await issued.json().catch(() => ({}))) as { result?: { jwt?: string }; errors?: { message?: string }[] };
    if (!issued.ok || !issuedBody.result?.jwt) {
      return { ok: false, message: `Cloudflare would not issue an upload token (${issued.status}) — ${issuedBody.errors?.[0]?.message ?? 'check the account id and that the token carries Account · Cloudflare Pages · Edit'}.` };
    }
    const hash = await sha256HexOf(data);
    const upload = await fetch(`${api}/pages/assets/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issuedBody.result.jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify([{ base64: true, key: hash, metadata: { contentType: 'application/octet-stream' }, value: base64Of(data) }]),
    });
    if (!upload.ok) return { ok: false, message: `Cloudflare would not take the file (${upload.status}) — ${await failureDetail(upload)}` };
    const carried = loadPushed(host.id);
    const manifest: Record<string, string> = {};
    for (const [name, entry] of Object.entries(carried)) manifest[name] = entry.hash;
    manifest[path] = hash;
    const form = new FormData();
    form.set('manifest', JSON.stringify(manifest));
    form.set('branch', 'main');
    const deploy = await fetch(`${api}/accounts/${account}/pages/projects/${project}/deployments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    const body = (await deploy.json().catch(() => ({}))) as { result?: { environment?: string }; errors?: { message?: string }[] };
    if (!deploy.ok || !body.result) {
      return { ok: false, message: `Cloudflare would not create the deployment (${deploy.status}) — ${body.errors?.[0]?.message ?? 'check the project name, or drag the starter folder into the project by hand'}.` };
    }
    savePushed(host.id, { ...carried, [path]: { hash, size: data.length } });
    const preview = body.result.environment === 'preview' ? ' as a preview (the project’s production branch is not main)' : '';
    return { ok: true, message: `Pushed ${cid} to ${host.label} — the deployment is live${preview} and serves it at ${url}.`, url };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach api.cloudflare.com (${why}). Check the connection and the token, or drag the starter folder into the project.` };
  }
}

/**
 * Puts one content id on a Vercel project with the deployments API — no Git needed. The
 * new file goes in the body as base64; files pushed before are named by their digest, so
 * Vercel reuses the copies it already holds.
 */
async function pushVercel(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { project, token } = host.values;
  if (!project || !token) return { ok: false, message: 'Fill in the project name and access token first.' };
  if (data.length > 4 * 1024 * 1024) {
    return { ok: false, message: 'This file is bigger than the 4 MiB Vercel takes inline — drop the starter folder on vercel.com/new instead, or use one of the other platforms.' };
  }
  const path = contentPath(host.values, cid);
  const url = contentUrl(host.baseUrl, cid);
  const carried = loadPushed(host.id);
  try {
    const files: ({ file: string; sha: string; size: number } | { file: string; data: string; encoding: string })[] = Object.entries(carried).map(
      ([name, entry]) => ({ file: name, sha: entry.hash, size: entry.size })
    );
    files.push({ file: path, data: base64Of(data), encoding: 'base64' });
    const deploy = await fetch('https://api.vercel.com/v13/deployments?forceNew=1', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: project, target: 'production', projectSettings: { framework: null }, files }),
    });
    const body = (await deploy.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!deploy.ok || !body.id) return { ok: false, message: `Vercel would not create the deployment (${deploy.status}) — ${body.error?.message ?? 'check the token and the project name'}.` };
    savePushed(host.id, { ...carried, [path]: { hash: sha1hex(data), size: data.length } });
    return { ok: true, message: `Pushed ${cid} to ${host.label} — the deployment is building and serves it at ${url} in about a minute.`, url };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach api.vercel.com (${why}). Check the connection and the token, or drop the starter folder on vercel.com/new.` };
  }
}

/** Puts one content id on a Neocities site with its upload API (one multipart file). */
async function pushNeocities(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { apiKey } = host.values;
  if (!apiKey) return { ok: false, message: 'Fill in the API key first.' };
  const path = contentPath(host.values, cid);
  const url = contentUrl(host.baseUrl, cid);
  try {
    const form = new FormData();
    form.set(path, new Blob([data as unknown as BlobPart], { type: 'application/octet-stream' }), path.split('/').pop() ?? cid);
    const response = await fetch('https://neocities.org/api/upload', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form });
    const body = (await response.json().catch(() => ({}))) as { result?: string; message?: string };
    if (!response.ok || body.result !== 'success') {
      return { ok: false, message: `Neocities refused the upload (${response.status}) — ${body.message ?? 'check the API key in Settings → API Key'}.` };
    }
    return { ok: true, message: `Pushed ${cid} to ${host.label} — it serves it at ${url} at once.`, url };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach neocities.org (${why}). Check the connection and the API key.` };
  }
}

/** Commits one content id into a Codeberg (Forgejo) repository with its contents API. */
async function pushCodeberg(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { user, repo, branch, token } = host.values;
  if (!user || !repo || !token) return { ok: false, message: 'Fill in the user, repository and access token first.' };
  const path = contentPath(host.values, cid);
  const ref = (branch || 'main').trim();
  const api = `https://codeberg.org/api/v1/repos/${encodeURIComponent(user)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { authorization: `token ${token}`, accept: 'application/json', 'content-type': 'application/json' };
  try {
    // An existing file is updated with its current sha; a missing one is created.
    const existing = await fetch(`${api}?ref=${encodeURIComponent(ref)}`, { headers });
    if (existing.status === 401 || existing.status === 403) {
      return { ok: false, message: 'Codeberg refused the access token — generate one with the repository write scope (avatar → Settings → Applications).' };
    }
    let sha: string | undefined;
    if (existing.ok) sha = ((await existing.json()) as { sha?: string }).sha;
    const response = await fetch(api, {
      method: sha ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify({ branch: ref, content: base64Of(data), message: `Provider job: publish ${cid}`, ...(sha ? { sha } : {}) }),
    });
    const body = (await response.json().catch(() => ({}))) as { commit?: { html_url?: string }; message?: string };
    if (!response.ok) {
      return { ok: false, message: `Codeberg refused the push (${response.status}) — ${body.message ?? 'check the repository name and that the branch exists'}.` };
    }
    return { ok: true, message: `Pushed ${cid} to ${host.label} — Codeberg Pages serves it at ${contentUrl(host.baseUrl, cid)} in about a minute.`, url: body.commit?.html_url };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach codeberg.org (${why}). Check the connection and the token, or add ${path} by hand in the repository.` };
  }
}

/** Puts one content id into an S3 bucket: one signed PUT (Signature V4). */
async function pushAws(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { bucket, region, accessKeyId, secretAccessKey } = host.values;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    return { ok: false, message: 'Fill in the bucket name, the region, the access key id and the secret access key first.' };
  }
  const key = contentPath(host.values, cid);
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
  const web = contentUrl(host.baseUrl, cid);
  try {
    const headers = await sigV4({
      method: 'PUT',
      url,
      region,
      service: 's3',
      accessKeyId,
      secretAccessKey,
      payload: data,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const response = await fetch(url, { method: 'PUT', headers, body: data as unknown as BodyInit });
    if (!response.ok) {
      return { ok: false, message: `S3 refused the upload (${response.status}) — ${await failureDetail(response)}. Check the region, and that the key may write objects (s3:PutObject).` };
    }
    return { ok: true, message: `Pushed ${cid} to ${host.label} — the bucket serves it at ${web}.`, url: web };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach ${bucket}.s3.${region}.amazonaws.com (${why}). Check the connection, the region and the keys.` };
  }
}

/** Puts one content id into the $web container of an Azure storage account (Shared Key). */
async function pushAzure(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { account, key } = host.values;
  if (!account || !key) return { ok: false, message: 'Fill in the storage account name and the access key first.' };
  const blob = contentPath(host.values, cid);
  const url = `https://${account}.blob.core.windows.net/$web/${blob.split('/').map(encodeURIComponent).join('/')}`;
  const web = contentUrl(host.baseUrl, cid);
  const version = '2021-08-06';
  const date = new Date().toUTCString();
  try {
    // The Shared Key signature covers the verb, eleven header lines (the empty ones too),
    // the x-ms- headers and the resource — that is the format Azure documents.
    const stringToSign = [
      'PUT',
      '',
      '',
      String(data.length),
      '',
      'application/octet-stream',
      '',
      '',
      '',
      '',
      '',
      '',
      `x-ms-blob-type:BlockBlob\nx-ms-date:${date}\nx-ms-version:${version}`,
      `/${account}/$web/${blob}`,
    ].join('\n');
    const signature = await hmacBase64Of('SHA-256', bytesFromBase64(key), stringToSign);
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `SharedKey ${account}:${signature}`,
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-date': date,
        'x-ms-version': version,
        'content-type': 'application/octet-stream',
      },
      body: data as unknown as BodyInit,
    });
    if (!response.ok) {
      return { ok: false, message: `Azure refused the upload (${response.status}) — ${await failureDetail(response)}. Check the account name, the key1 value and that the static website is enabled.` };
    }
    return { ok: true, message: `Pushed ${cid} to ${host.label} — the static website serves it at ${web}.`, url: web };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach ${account}.blob.core.windows.net (${why}). Check the connection, the account name and the key.` };
  }
}

/** Puts one content id into a Cloud Storage bucket with an HMAC key (the GOOG1 scheme). */
async function pushGoogleCloud(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { bucket, accessKey, secret } = host.values;
  if (!bucket || !accessKey || !secret) {
    return { ok: false, message: 'Fill in the bucket name, the HMAC access key id and the HMAC secret first.' };
  }
  const object = contentPath(host.values, cid);
  const url = `https://storage.googleapis.com/${bucket}/${object.split('/').map(encodeURIComponent).join('/')}`;
  const web = contentUrl(host.baseUrl, cid);
  try {
    const signed = await sigV2({ method: 'PUT', url, accessKeyId: accessKey, secretAccessKey: secret, contentType: 'application/octet-stream', prefix: 'GOOG1' });
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...signed, 'content-type': 'application/octet-stream' },
      body: data as unknown as BodyInit,
    });
    if (!response.ok) {
      return { ok: false, message: `Cloud Storage refused the upload (${response.status}) — ${await failureDetail(response)}. Check the bucket, the HMAC keys and that allUsers may read (Storage Object Viewer).` };
    }
    return { ok: true, message: `Pushed ${cid} to ${host.label} — the bucket serves it at ${web}.`, url: web };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach storage.googleapis.com (${why}). Check the connection and the HMAC keys.` };
  }
}

/** A Google OAuth access token minted from a service account key (the RS256 JWT exchange). */
async function googleAccessToken(email: string, privateKey: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await rsaSha256Jwt({ iss: email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, privateKey);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `Google refused the service account key (${response.status})`);
  }
  return body.access_token;
}

/**
 * Publishes one content id to Firebase Hosting as a new version and release: the REST
 * deploy flow the Firebase CLI uses (version → populateFiles → upload the gzip → finalize
 * → release), authenticated with the service account key the wizard collected.
 */
async function pushFirebase(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { project, key } = host.values;
  if (!project || !key) return { ok: false, message: 'Fill in the project id and the service account key first.' };
  let account: { client_email?: string; private_key?: string };
  try {
    account = JSON.parse(key) as { client_email?: string; private_key?: string };
  } catch {
    return { ok: false, message: 'That is not the service account JSON file Firebase downloads — paste its whole contents (Project settings → Service accounts → Generate new private key).' };
  }
  if (!account.client_email || !account.private_key) {
    return { ok: false, message: 'The service account JSON has no client_email/private_key — download it again in Project settings → Service accounts.' };
  }
  const path = `/${contentPath(host.values, cid)}`;
  const url = contentUrl(host.baseUrl, cid);
  const api = `https://firebasehosting.googleapis.com/v1beta1/sites/${encodeURIComponent(project)}`;
  try {
    const token = await googleAccessToken(account.client_email, account.private_key, 'https://www.googleapis.com/auth/firebase');
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const created = await fetch(`${api}/versions?sizeBytes=${data.length}`, { method: 'POST', headers, body: '{}' });
    const version = (await created.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
    if (!created.ok || !version.name) {
      return { ok: false, message: `Firebase would not open a version (${created.status}) — ${version.error?.message ?? 'check the project id and that Hosting is set up in the console'}.` };
    }
    // Files are named by the SHA-256 of their gzipped bytes, exactly like the CLI does.
    const zipped = await gzip(data);
    const hash = await sha256HexOf(zipped);
    const populated = await fetch(`https://firebasehosting.googleapis.com/v1beta1/${version.name}:populateFiles`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ files: { [path]: hash } }),
    });
    const plan = (await populated.json().catch(() => ({}))) as { uploadUrl?: string; uploadRequiredHashes?: string[]; error?: { message?: string } };
    if (!populated.ok || !plan.uploadUrl) {
      return { ok: false, message: `Firebase would not take the file list (${populated.status}) — ${plan.error?.message ?? 'check the service account’s permissions'}.` };
    }
    if (plan.uploadRequiredHashes?.includes(hash)) {
      const upload = await fetch(`${plan.uploadUrl}/${hash}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: zipped as unknown as BodyInit,
      });
      if (!upload.ok) return { ok: false, message: `Firebase would not accept the file (${upload.status}) — ${await failureDetail(upload)}` };
    }
    const finalized = await fetch(`https://firebasehosting.googleapis.com/v1beta1/${version.name}?update_mask=status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'FINALIZED' }),
    });
    if (!finalized.ok) return { ok: false, message: `Firebase would not finalize the version (${finalized.status}) — ${await failureDetail(finalized)}` };
    const released = await fetch(`${api}/releases?versionName=${encodeURIComponent(version.name)}`, { method: 'POST', headers, body: '{}' });
    if (!released.ok) {
      return { ok: false, message: `The version is ready but the release failed (${released.status}) — ${await failureDetail(released)}. Release it in the console (Hosting → Release).` };
    }
    return { ok: true, message: `Pushed ${cid} to ${host.label} — the release serves it at ${url} (a version carries the files it was given: push the ids you need together).`, url };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not deploy through firebasehosting.googleapis.com (${why}). Check the connection, the project id and the service account key.` };
  }
}

/** The site id inside an Appwrite built-in domain: `<site>.<region>.appwrite.site`. */
function appwriteSiteId(values: Record<string, string>): string {
  const given = (values.site ?? '').trim();
  if (given) return given;
  const host = (values.endpoint ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host.split('.')[0] ?? '';
}

/**
 * Deploys one content id to an Appwrite site as a manual deployment. Appwrite takes the
 * whole site as a gzip of a tar, so the push carries the content id together with the
 * VibeShare welcome page as index.html and activates it.
 */
async function pushAppwrite(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { project, key } = host.values;
  const api = 'https://cloud.appwrite.io/v1';
  if (!project || !key) return { ok: false, message: 'Fill in the project id and the API key first.' };
  const site = appwriteSiteId(host.values);
  if (!site) return { ok: false, message: 'Fill in the site id — the first part of the site’s built-in domain, before the region.' };
  const path = contentPath(host.values, cid);
  const url = contentUrl(host.baseUrl, cid);
  const headers = { 'x-appwrite-project': project, 'x-appwrite-key': key, accept: 'application/json' };
  try {
    const known = await fetch(`${api}/sites/${encodeURIComponent(site)}`, { headers });
    if (!known.ok) {
      const detail = await failureDetail(known);
      return { ok: false, message: `Appwrite does not answer for the site ${site} in this project (${known.status}) — ${detail}. Check the project id and the site id.` };
    }
    const archive = await gzip(tarOf([{ path: 'index.html', data: new TextEncoder().encode(STARTER_HTML) }, { path, data }]));
    const form = new FormData();
    form.set('code', new Blob([archive as unknown as BlobPart], { type: 'application/gzip' }), 'code.tar.gz');
    form.set('activate', 'true');
    form.set('entrypoint', 'index.html');
    const created = await fetch(`${api}/sites/${encodeURIComponent(site)}/deployments`, { method: 'POST', headers, body: form });
    const body = (await created.json().catch(() => ({}))) as { $id?: string; status?: string; message?: string };
    if (!created.ok) {
      return { ok: false, message: `Appwrite refused the deployment (${created.status}) — ${body.message ?? 'check that the API key carries the sites.read and sites.write scopes'}.` };
    }
    return {
      ok: true,
      message: `Pushed ${cid} to ${host.label} — the deployment is building (the welcome page as index.html plus ${path}) and serves it at ${url} once it turns Active.`,
      url,
    };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach cloud.appwrite.io (${why}). Check the connection, the project id and the API key.` };
  }
}

/**
 * Puts one content id on a Render static site: the bytes go into the repository Render
 * builds from (the same contents API GitHub uses) and a deploy is asked for, so the site
 * serves the file once the build finishes.
 */
async function pushRender(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { repo, branch, ghToken, token, service } = host.values;
  const [owner, name] = (repo ?? '').split('/').map((part) => part.trim());
  if (!owner || !name || !ghToken) return { ok: false, message: 'Fill in the repository (owner/name) and the GitHub token first.' };
  // The commit lands through GitHub; Render rebuilds the moment the repository changes.
  const commit = await pushGitHub({ ...host, values: { ...host.values, owner, repo: name, token: ghToken, branch: branch || 'main' } }, cid, data);
  if (!commit.ok) return commit;
  const url = contentUrl(host.baseUrl, cid);
  // Asking Render for a deploy on top is a courtesy — the commit already triggers one.
  if (token) {
    try {
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      const list = await fetch('https://api.render.com/v1/services?limit=100', { headers });
      const found = ((await list.json().catch(() => [])) as { id?: string; name?: string; service?: { id?: string; name?: string } }[])
        .map((entry) => entry.service ?? entry)
        .find((entry) => entry.name === (service ?? '').trim());
      if (found?.id) {
        await fetch(`https://api.render.com/v1/services/${encodeURIComponent(found.id)}/deploys`, { method: 'POST', headers, body: '{}' }).catch(() => undefined);
      }
    } catch {
      // The commit alone already makes Render rebuild.
    }
  }
  return { ok: true, message: `Pushed ${cid} to ${host.label} — Render rebuilds now and serves it at ${url} in a few minutes.`, url };
}

/**
 * Publishes one content id to a Surge domain: a gzip tar of the welcome page and the
 * content id, posted to the domain with the login token — the call the surge command
 * itself makes.
 */
async function pushSurge(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  const { domain, token } = host.values;
  if (!domain || !token) return { ok: false, message: 'Fill in the domain and the login token first.' };
  const path = contentPath(host.values, cid);
  const url = contentUrl(host.baseUrl, cid);
  try {
    const archive = await gzip(tarOf([{ path: 'index.html', data: new TextEncoder().encode(STARTER_HTML) }, { path, data }]));
    const response = await fetch(`https://surge.surge.sh/${domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}`, {
      method: 'POST',
      headers: {
        // The surge command signs in as “token” with the login token as the password.
        authorization: `Basic ${base64Of(new TextEncoder().encode(`token:${token}`))}`,
        'content-type': 'application/gzip',
      },
      body: archive as unknown as BodyInit,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'Surge refused the login token — run “surge token” again and paste the new one.' };
    }
    if (!response.ok) {
      const detail = await failureDetail(response);
      return { ok: false, message: `Surge did not accept the publish (${response.status}) — ${detail}. Check the domain and the token.` };
    }
    return { ok: true, message: `Pushed ${cid} to ${host.label} — Surge serves it at ${url}.`, url };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not reach surge.surge.sh (${why}). Check the connection, the domain and the login token.` };
  }
}

/**
 * Pushes one content id's bytes to a saved host. Every platform's pipeline is wired up —
 * the default below is only a safety net for a host saved with a platform this build does
 * not know.
 */
export async function pushHostedContent(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  switch (host.platform) {
    case 'github':
      return pushGitHub(host, cid, data);
    case 'gitlab':
      return pushGitLab(host, cid, data);
    case 'netlify':
      return pushNetlify(host, cid, data);
    case 'cloudflare':
      return pushCloudflare(host, cid, data);
    case 'vercel':
      return pushVercel(host, cid, data);
    case 'firebase':
      return pushFirebase(host, cid, data);
    case 'render':
      return pushRender(host, cid, data);
    case 'appwrite':
      return pushAppwrite(host, cid, data);
    case 'surge':
      return pushSurge(host, cid, data);
    case 'neocities':
      return pushNeocities(host, cid, data);
    case 'codeberg':
      return pushCodeberg(host, cid, data);
    case 'aws':
      return pushAws(host, cid, data);
    case 'azure':
      return pushAzure(host, cid, data);
    case 'gcloud':
      return pushGoogleCloud(host, cid, data);
    default: {
      const platform = hostingPlatform(host.platform);
      return {
        ok: false,
        message: `This build has no push pipeline for ${platform.name}. The base URL and the content id path work — put the bytes at ${contentUrl(host.baseUrl, cid)} by hand.`,
      };
    }
  }
}
const join = (...parts: string[]): string => parts.map((part) => part.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
