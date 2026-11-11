// Free static hosting platforms provider jobs can push content to. Each platform shows
// how to open an account and publish a base URL; the GUI builds that base URL from the
// entered values and appends content ids to it, so providers can query `<base>/<cid>`.
// Pushing job data to a site is wired up for every platform here: each entry says which
// API its pipeline calls.
import { sha1hex } from '../../../src/shared/crypto';
import { base64Of, bytesFromBase64, gzip, hmacBase64Of, rsaSha256Jwt, sha256HexOf, sigV2, sigV4, tarOf } from './signing';

/** One input of a platform's setup form. */
export interface HostingField {
  id: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** Access tokens and API keys: shown as a password field. */
  secret?: boolean;
  default?: string;
}

/** One step of a platform's setup: what to do in order, what to copy instead of typing,
 * and the check that ends the step — so the reader knows exactly what they have when
 * they tick it off.
 */
export interface HostingStep {
  /** Short title, e.g. "Create the repository". */
  title: string;
  /** The exact clicks and pastes in order — one line each, nothing assumed. */
  lines: string[];
  /** Values to copy instead of typing (names, URLs, commands, policies). */
  copies?: { label: string; value: string }[];
  /** Pages to open in this step. */
  links?: { label: string; url: string }[];
  /** Field ids this step fills in: their inputs are shown right under it. */
  fields?: string[];
  /** A starter to download instead of making by hand: a zip of these files — or the file
   * itself when there is one and its name is not a .zip. */
  download?: { label: string; zip: string; entries: { path: string; text: string }[] };
  /** What you have when this step is done. The reader ticks it off. */
  check: string;
}

/** A free hosting platform: its signup, its setup steps and the fields its base URL needs. */
export interface HostingPlatform {
  id: string;
  name: string;
  /** Where to open the free account. */
  signup: string;
  /** Where the platform explains publishing a static site. */
  docs: string;
  about: string;
  /** How to create the account and get the site serving files, in order. */
  steps: HostingStep[];
  fields: HostingField[];
  /** The default published base URL from the entered values (with its trailing slash). */
  buildBaseUrl: (values: Record<string, string>) => string;
  /** The site root the panel-1 check probes (when the content folder may not exist yet). */
  buildSiteUrl?: (values: Record<string, string>) => string;
  /** Which push pipeline this platform's `publish` runs; every one of them is wired up. */
  publish?: 'github' | 'gitlab' | 'netlify' | 'cloudflare' | 'vercel' | 'firebase' | 'render' | 'appwrite' | 'surge' | 'neocities' | 'codeberg' | 'aws' | 'azure' | 'gcloud';
}

/** A saved base URL: one platform account the user configured. */
export interface HostConfig {
  id: string;
  platform: string;
  /** User label, e.g. "My GitHub Pages". */
  label: string;
  /** Base URL with a trailing slash; content ids are appended to it. */
  baseUrl: string;
  /** What the platform's form was filled with (including any token). */
  values: Record<string, string>;
  /** Skeleton switch: push provider job data to the site automatically. */
  autoPush: boolean;
  createdAt: string;
}

export interface PushResult {
  ok: boolean;
  message: string;
  /** Where the pushed file is visible, when the platform answers with one. */
  url?: string;
}

/** Joins URL path parts with single slashes and a trailing slash. */
export function buildUrl(base: string, ...parts: string[]): string {
  const path = parts.map((part) => part.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  return `https://${base.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/${path}${path ? '/' : ''}`;
}

/** `<base>/<cid>` — the URL providers query for a piece of content. */
export function contentUrl(baseUrl: string, cid: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${cid.trim().replace(/^\/+/, '')}`;
}

/** The file path inside the site (and its git repository) that serves one content id. */
export function contentPath(values: Record<string, string>, cid: string): string {
  const folder = (values.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
  return `${folder ? `${folder}/` : ''}${cid.trim().replace(/^\/+/, '')}`;
}

/**
 * The content id of the default article describing VibeShare. It is hard coded into the
 * client so a job is never blocked on finding one: when no jobs are found on a provider
 * node, or a plain content id is needed to try a base URL with, always use this one.
 */
export const DUMMY_CID = 'vs1fvghgh33iz7bzlpv6manelcghldqf3fwjh7l57wnm3nj7br6aayq';

// ------------------------------------------------------------------------ zip helper

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A stored (uncompressed) ZIP of small text files — the starter folder the reader
 * downloads and drags onto a host instead of making an index.html by hand.
 */
export function buildZip(entries: { path: string; text: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, 0, true); // stored
    view.setUint16(12, 0x21, true); // 1980-01-01
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);
    const head = new Uint8Array(46 + name.length);
    const cview = new DataView(head.buffer);
    cview.setUint32(0, 0x02014b50, true);
    cview.setUint16(4, 20, true);
    cview.setUint16(6, 20, true);
    cview.setUint16(8, 0x0800, true);
    cview.setUint16(14, 0x21, true);
    cview.setUint32(16, crc, true);
    cview.setUint32(20, data.length, true);
    cview.setUint32(24, data.length, true);
    cview.setUint16(28, name.length, true);
    cview.setUint32(42, offset, true);
    head.set(name, 46);
    central.push(head);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true);
  eview.setUint16(8, entries.length, true);
  eview.setUint16(10, entries.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}


/** The starter page in the download folder: a welcome screen for a fresh data host. */
const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VibeShare data host</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 20px;color:#222}h1{font-size:22px}code{background:#f2f2f7;padding:2px 6px;border-radius:6px}</style>
</head>
<body>
<h1>VibeShare data host</h1>
<p>This site hosts content for VibeShare provider jobs: every content id lives at <code>&lt;base&gt;/&lt;content-id&gt;</code>, and providers download the bytes from here and pay for them.</p>
<p>Content ids are pushed into the <code>public</code> folder of this site. This page is only the welcome screen.</p>
</body>
</html>
`;

export const HOSTING_PLATFORMS: HostingPlatform[] = [
  {
    id: 'github',
    name: 'GitHub Pages',
    signup: 'https://github.com/signup',
    docs: 'https://docs.github.com/en/pages',
    about: 'A free GitHub account serves a repository as a static site at <user>.github.io. No credit card.',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below with any email address.', 'Confirm the email GitHub sends you, then sign in.'],
        links: [{ label: 'Sign up for GitHub', url: 'https://github.com/signup' }],
        check: 'You are signed in to github.com and see your avatar in the top right corner.',
      },
      {
        title: 'Create the repository the site lives in',
        lines: [
          'Open “New repository” (link below).',
          'Owner: keep your name. Repository name: paste the value below. Visibility: Public.',
          'Turn on “Add a README file”, then click “Create repository”.',
        ],
        copies: [{ label: 'Repository name', value: 'vibeshare-data' }],
        links: [{ label: 'New repository', url: 'https://github.com/new' }],
        check: 'The repository page is open and shows a “Public” badge beside its name.',
      },
      {
        title: 'Add a first file so the site has a page',
        lines: [
          'Download the starter page below.',
          'In the repository click “Add file” → “Upload files”, pick the downloaded file, then click “Commit changes”.',
        ],
        copies: [{ label: 'File name', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'index.html is listed in the repository file list.',
      },
      {
        title: 'Turn GitHub Pages on',
        lines: [
          'In the repository open “Settings” → “Pages” (left sidebar).',
          'Under “Build and deployment”, Source: “Deploy from a branch”.',
          'Branch: main, folder: / (root) → click “Save”.',
        ],
        check: 'The Pages section says “Your site is live at https://…”.',
      },
      {
        title: 'See your site',
        lines: ['Wait up to 10 minutes, then open the address below (replace YOUR-NAME with your GitHub name).'],
        copies: [{ label: 'Site address', value: 'https://YOUR-NAME.github.io/vibeshare-data/' }],
        check: 'That address opens your page in a new tab — not a 404.',
      },
      {
        title: 'Create the access token the client pushes with',
        lines: [
          'Click your avatar → “Settings” → “Developer settings” (bottom of the left sidebar).',
          '“Personal access tokens” → “Fine-grained tokens” → “Generate new token”.',
          'Token name: vibeshare. Repository access: “Only select repositories” → pick vibeshare-data.',
          'Repository permissions → “Contents”: Read and write → “Generate token”.',
          'Copy the token now — it is shown only once.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        check: 'You have a token starting with github_pat_ saved somewhere for the next step.',
      },
    ],
    fields: [
      { id: 'owner', label: 'User or organization', placeholder: 'yourname', hint: 'The account that owns the repository.' },
      { id: 'repo', label: 'Repository', placeholder: 'vibeshare-data', hint: 'Public, with GitHub Pages enabled.' },
      { id: 'branch', label: 'Branch', default: 'main', hint: 'The branch Pages deploys from.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public', hint: 'Files land at <folder>/<cid>; leave empty for the repository root.' },
      { id: 'token', label: 'Access token', secret: true, hint: 'Fine-grained token with Contents: Read and write on the repository.' },
    ],
    buildBaseUrl: (values) => {
      const owner = (values.owner ?? '').trim();
      const repo = (values.repo ?? '').trim();
      const folder = (values.folder ?? '').trim();
      const root = repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;
      return buildUrl(`${owner}.github.io`, ...(root ? [folder] : [repo, folder]));
    },
    publish: 'github',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Pages',
    signup: 'https://dash.cloudflare.com/sign-up',
    docs: 'https://developers.cloudflare.com/pages/',
    about: 'Free static sites on a <project>.pages.dev address with unlimited bandwidth. No credit card.',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below (email and password is enough).', 'Confirm the address Cloudflare emails you, then sign in.'],
        links: [{ label: 'Sign up for Cloudflare', url: 'https://dash.cloudflare.com/sign-up' }],
        check: 'You are in the Cloudflare dashboard and see “Workers & Pages” in the left sidebar.',
      },
      {
        title: 'Create the Pages project and upload a first file',
        lines: [
          'Open “Workers & Pages” → “Create application” → “Pages” → “Upload assets”.',
          'Project name: paste the value below → “Continue”.',
          'Make nothing by hand: download and unzip the starter folder below, and drag that folder onto the box.',
          'Click “Deploy site”.',
        ],
        copies: [{ label: 'Project name', value: 'vibeshare-data' }],
        download: {
          label: 'Download the starter folder (zip)',
          zip: 'VibeShare.zip',
          entries: [{ path: 'VibeShare/index.html', text: STARTER_HTML }],
        },
        check: 'The project overview shows “vibeshare-data.pages.dev”.',
      },
      {
        title: 'See your site',
        lines: ['Open the address below in a new tab.'],
        copies: [{ label: 'Site address', value: 'https://vibeshare-data.pages.dev/' }],
        check: 'The address opens the page you uploaded.',
      },
      {
        title: 'Create the API token the client pushes with',
        lines: [
          'Profile icon (top right) → “My Profile” → “API Tokens” → “Create Token”.',
          'Pick “Custom token” → “Get started”.',
          'Permissions: Account · Cloudflare Pages · Edit. Account Resources: your account.',
          '“Continue to summary” → “Create Token”, then copy it — it is shown only once.',
        ],
        check: 'You have copied a token (a long letters-and-numbers string) for the next step.',
      },
    ],
    fields: [
      { id: 'account', label: 'Account id', placeholder: '1f3a…', hint: 'Shown in the URL of Workers & Pages, or in the sidebar of the dashboard.' },
      { id: 'project', label: 'Project name', placeholder: 'vibeshare-data' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'token', label: 'API token', secret: true, hint: 'Custom token with Account · Cloudflare Pages · Edit.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.project ?? '').trim()}.pages.dev`, values.folder ?? ''),
    // Wired up: the push pipeline uploads each content id with the Pages direct upload API
    // (POST /accounts/<account>/pages/projects/<project>/deployments).
    publish: 'cloudflare',
  },
  {
    id: 'gitlab',
    name: 'GitLab Pages',
    signup: 'https://gitlab.com/users/sign_up',
    docs: 'https://docs.gitlab.com/user/project/pages/',
    about: 'Free project sites at <namespace>.gitlab.io/<project>/, published by the project pipeline. No credit card.',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below and confirm the email.', 'Sign in to gitlab.com.'],
        links: [{ label: 'Sign up for GitLab', url: 'https://gitlab.com/users/sign_up' }],
        check: 'You are signed in and can open “New project”.',
      },
      {
        title: 'Create the project',
        lines: [
          'Click “New project” → “Create blank project”.',
          'Project name: paste the value below. Visibility: Public. Keep “Initialize repository with a README”.',
          'Click “Create project”.',
        ],
        copies: [{ label: 'Project name', value: 'vibeshare-data' }],
        check: 'The project page is open with a README.md in the file list.',
      },
      {
        title: 'Add the page the site serves',
        lines: [
          'Download the starter page below.',
          'Click “+” → “Upload file”, pick the downloaded file and set its folder to public — the page must land at the path below, and Pages publishes the public folder as the site.',
          'Click “Commit changes”.',
        ],
        copies: [{ label: 'File name (a path, folder included)', value: 'public/index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'public/index.html is listed in the project files.',
      },
      {
        title: 'Add the pipeline file that publishes the site',
        lines: [
          'Download the pipeline file below.',
          'Click “+” → “Upload file” again, pick the downloaded file (its name is exactly as below), then “Commit changes”.',
          'There is nothing to build: the job publishes the public folder exactly as it is in the repository.',
        ],
        copies: [
          { label: 'File name', value: '.gitlab-ci.yml' },
          {
            label: 'Contents (paste as one block)',
            value: 'pages:\n  script:\n    - echo "Publishing public/"\n  artifacts:\n    paths:\n      - public',
          },
        ],
        download: {
          label: 'Download the pipeline file',
          zip: '.gitlab-ci.yml',
          entries: [{ path: '.gitlab-ci.yml', text: 'pages:\n  script:\n    - echo "Publishing public/"\n  artifacts:\n    paths:\n      - public' }],
        },
        check: 'Build → Pipelines shows a green pipeline with a “pages” job in it.',
      },
      {
        title: 'See your site',
        lines: [
          'Wait a minute, then open the address below (replace YOUR-NAME with your GitLab user or group path).',
          'The pipeline publishes public/ as the site.',
        ],
        copies: [{ label: 'Site address', value: 'https://YOUR-NAME.gitlab.io/vibeshare-data/' }],
        check: 'That address opens your index.html.',
      },
    ],
    fields: [
      { id: 'namespace', label: 'User or group', placeholder: 'yourname', hint: 'The path your project lives under.' },
      { id: 'project', label: 'Project', placeholder: 'vibeshare-data' },
      { id: 'branch', label: 'Branch', default: 'main', hint: 'The branch the pages job runs on (Manage → Repository → Branches).' },
      {
        id: 'folder',
        label: 'Folder for content ids',
        default: 'public',
        hint: 'The folder Pages publishes (public). The file lands at <folder>/<cid> and is served at /<cid> — the folder itself is not part of the address.',
      },
      { id: 'token', label: 'Access token', secret: true, hint: 'Avatar → Edit profile → Access → Personal access tokens, scope api (read-write).' },
    ],
    // Pages publishes the folder (public/) as the site root, so the folder is not in the
    // address: a file at public/<cid> is served at /<cid>.
    buildBaseUrl: (values) => buildUrl(`${(values.namespace ?? '').trim()}.gitlab.io`, (values.project ?? '').trim()),
    // Wired: commits each content id with the GitLab files API (POST or PUT
    // /api/v4/projects/<id>/repository/files/<path>, authenticated with PRIVATE-TOKEN).
    publish: 'gitlab',
  },
  {
    id: 'netlify',
    name: 'Netlify',
    signup: 'https://app.netlify.com/signup',
    docs: 'https://docs.netlify.com/get-started/',
    about: 'Drag a folder onto Netlify Drop and it is online at <name>.netlify.app in seconds. No credit card.',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below (an email address, or continue with GitHub).'],
        links: [{ label: 'Sign up for Netlify', url: 'https://app.netlify.com/signup' }],
        check: 'You are in the Netlify dashboard and see “Add new site”.',
      },
      {
        title: 'Deploy a first folder',
        lines: [
          '“Add new site” → “Deploy manually”.',
          'Download the folder below (a zip with VibeShare/index.html), unzip it, and drag the VibeShare folder onto the big drop area.',
          'Wait for “Site is live”.',
        ],
        download: {
          label: 'Download the VibeShare folder (zip)',
          zip: 'VibeShare.zip',
          entries: [{ path: 'VibeShare/index.html', text: STARTER_HTML }],
        },
        check: 'The Deploys page lists a deployment and shows a *.netlify.app address.',
      },
      {
        title: 'Name your project',
        lines: [
          'Type the project name below — the site is served at <name>.netlify.app.',
          'The name is kept for the next step (Access details) automatically.',
        ],
        fields: ['site'],
        check: 'The Project name field below is filled in.',
      },
      {
        title: 'See your site',
        lines: ['Open the address below in a new tab — it is the project name you typed in step 3, as <name>.netlify.app.'],
        copies: [{ label: 'Site address', value: 'https://<site>.netlify.app/' }],
        check: 'That address opens your page.',
      },
      {
        title: 'Create the access token the client pushes with',
        lines: [
          'Click your avatar in the left panel at the bottom left → “User settings” → “Applications”.',
          'Under “Personal access tokens” click “New access token”, name it vibeshare, and set the expiration date for this token to whatever timespan you would like, then “Generate”.',
          'Copy it now (it starts with nfp_) — Netlify shows it only once.',
          'Paste it into the field below — it is kept for the next step (Access details) automatically.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field below is filled with an nfp_ token.',
      },
      {
        title: 'Make the site public',
        lines: ['In project configuration → Project details → Visitor access, set the “Visibility” to public and Save.'],
        check: 'Visitor access shows Visibility: public.',
      },
    ],
    fields: [
      { id: 'site', label: 'Project name', placeholder: 'vibeshare-data', hint: 'The site is served at <name>.netlify.app — Site configuration → Change site name.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'token', label: 'Access token', secret: true, hint: 'User settings → Applications → personal access token.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.site ?? '').trim()}.netlify.app`, values.folder ?? ''),
    buildSiteUrl: (values) => buildUrl(`${(values.site ?? '').trim()}.netlify.app`),
    // Wired up: the push creates a deployment with the files API
    // (POST https://api.netlify.com/api/v1/sites/<site>/deploys), carrying everything the
    // site already serves plus the content id, and the deploy goes live by itself.
    publish: 'netlify',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    signup: 'https://vercel.com/signup',
    docs: 'https://vercel.com/docs',
    about: 'Vercel Drop puts a folder online at <name>.vercel.app. Free hobby plan, no credit card.',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below (continue with GitHub is one click).'],
        links: [{ label: 'Sign up for Vercel', url: 'https://vercel.com/signup' }],
        check: 'You are in the Vercel dashboard and see “Add New…”.',
      },
      {
        title: 'Deploy a first folder with Vercel Drop',
        lines: [
          'Open the Vercel Drop link below in your browser.',
          'Download and unzip the starter folder below, and drag that folder onto the page.',
          'Wait for “Congratulations!” and the project URL.',
        ],
        copies: [{ label: 'Folder contents', value: 'index.html' }],
        download: {
          label: 'Download the starter folder (zip)',
          zip: 'VibeShare.zip',
          entries: [{ path: 'VibeShare/index.html', text: STARTER_HTML }],
        },
        links: [{ label: 'Vercel Drop', url: 'https://vercel.com/new/drop' }],
        check: 'The deployment page shows a project with a *.vercel.app address.',
      },
      {
        title: 'Name the project',
        lines: [
          'Open the project → “Settings” → “General” → “Project Name”.',
          'Type the name below and paste it there, then click “Save” — the site is served at <project>.vercel.app.',
          'The name is kept for the rest of the panels automatically.',
        ],
        fields: ['project'],
        check: 'The Project name field below is filled in.',
      },
      {
        title: 'See your site',
        lines: ['Open the address below in a new tab.'],
        copies: [{ label: 'Site address', value: 'https://<project>.vercel.app/' }],
        check: 'That address opens your page.',
      },
    ],
    fields: [
      { id: 'project', label: 'Project name', placeholder: 'vibeshare-data' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'token', label: 'Access token', secret: true, hint: 'Account Settings → Tokens.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.project ?? '').trim()}.vercel.app`, values.folder ?? ''),
    buildSiteUrl: (values) => buildUrl(`${(values.project ?? '').trim()}.vercel.app`),
    // Wired up: the push pipeline creates a deployment with the REST API
    // (POST https://api.vercel.com/v13/deployments), reusing the copies Vercel already holds.
    publish: 'vercel',
  },
  {
    id: 'firebase',
    name: 'Firebase Hosting',
    signup: 'https://console.firebase.google.com/',
    docs: 'https://firebase.google.com/docs/hosting',
    about: 'Google’s free hosting on a <project>.web.app address. The Spark plan needs no credit card; four copy-pasted commands do the work.',
    steps: [
      {
        title: 'Create the free project',
        lines: [
          'Sign in with a Google account at the link below (no billing needed on the free plan).',
          'Click “Create a project” → name it as below → “Continue” → “Continue” → decline Analytics → “Create project”.',
        ],
        copies: [{ label: 'Project name (letters and dashes)', value: 'vibeshare-data' }],
        links: [{ label: 'Firebase console', url: 'https://console.firebase.google.com/' }],
        check: 'The Firebase console shows your project and its Overview page.',
      },
      {
        title: 'Open Hosting and get the CLI',
        lines: [
          'In the left sidebar: “Build” → “Hosting” → “Get started”.',
          'Run the two commands below in a terminal, one after the other.',
          'The second opens a browser window — click “Allow”.',
        ],
        copies: [
          { label: 'Command 1 — install', value: 'npm install --global firebase-tools' },
          { label: 'Command 2 — sign in', value: 'firebase login' },
        ],
        check: 'The terminal prints “✔ Success! Logged in as …”.',
      },
      {
        title: 'Point the CLI at your files',
        lines: [
          'Download and unzip the starter folder below, then run the command below inside that folder.',
          'Choose your project from the list.',
          '“What do you want to use as your public directory?” type a single dot and press Enter.',
          '“Configure as a single-page app?” press Enter (No). “Overwrite index.html?” press Enter (No).',
        ],
        copies: [{ label: 'Command — run inside your site folder', value: 'firebase init hosting' }],
        download: {
          label: 'Download the starter folder (zip)',
          zip: 'VibeShare.zip',
          entries: [{ path: 'VibeShare/index.html', text: STARTER_HTML }],
        },
        check: 'The folder now contains a .firebase/ directory and a firebase.json file.',
      },
      {
        title: 'Deploy',
        lines: ['Run the command below in the same folder.'],
        copies: [{ label: 'Command — publish', value: 'firebase deploy' }],
        check: 'The terminal prints “✔ Deploy complete!” and a “Hosting URL”.',
      },
      {
        title: 'See your site',
        lines: ['Open the address below, replacing PROJECT with the project id you chose (it is in the Hosting URL the deploy printed).'],
        copies: [{ label: 'Site address', value: 'https://PROJECT.web.app/' }],
        check: 'That address opens your index.html.',
      },
      {
        title: 'Create the access the client pushes with',
        lines: [
          'Project settings (gear icon) → “Service accounts”.',
          'Click “Generate new private key” → “Generate key”. A JSON file downloads — keep it.',
        ],
        check: 'A service account JSON file is saved on this device.',
      },
    ],
    fields: [
      { id: 'project', label: 'Project id', placeholder: 'vibeshare-data', hint: 'Project settings → General → Project id.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'key', label: 'Service account key', secret: true, hint: 'Project settings → Service accounts → Generate new private key (JSON).' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.project ?? '').trim()}.web.app`, values.folder ?? ''),
    // Wired up: the push pipeline deploys with the Hosting REST API
    // (sites/<site>/versions + release).
    publish: 'firebase',
  },
  {
    id: 'render',
    name: 'Render',
    signup: 'https://dashboard.render.com/register',
    docs: 'https://render.com/docs/static-sites',
    about: 'Free static sites at <name>.onrender.com, rebuilt from a Git repository. No credit card for static sites.',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below (continue with GitHub is one click).'],
        links: [{ label: 'Sign up for Render', url: 'https://dashboard.render.com/register' }],
        check: 'You are in the Render dashboard and see a “New +” button.',
      },
      {
        title: 'Have a Git repository ready',
        lines: [
          'Render only publishes from a Git repository — use the GitHub tab above to make one (public, with an index.html in it).',
          'Come back here once the repository exists on GitHub.',
        ],
        links: [{ label: 'Create a GitHub repository', url: 'https://github.com/new' }],
        check: 'Your GitHub repository shows an index.html file.',
      },
      {
        title: 'Create the static site',
        lines: [
          'In Render: “New +” → “Static Site”.',
          'Connect GitHub and pick your repository.',
          'Name: paste the value below. Build Command: leave empty. Publish Directory: paste a single dot.',
          'Click “Create Static Site”.',
        ],
        copies: [
          { label: 'Site name', value: 'vibeshare-data' },
          { label: 'Publish directory', value: '.' },
        ],
        check: 'The deploy log ends with “Build completed” and the site shows “Live”.',
      },
      {
        title: 'See your site',
        lines: ['Open the address below in a new tab.'],
        copies: [{ label: 'Site address', value: 'https://vibeshare-data.onrender.com/' }],
        check: 'That address opens your index.html.',
      },
      {
        title: 'Create the access token the client pushes with',
        lines: ['Avatar → “Account Settings” → “API Keys” → “Create API Key”.', 'Name it vibeshare → “Create”. Copy it now.'],
        check: 'You have copied a Render API key for the next step.',
      },
    ],
    fields: [
      { id: 'service', label: 'Site name', placeholder: 'vibeshare-data', hint: 'The name in the site URL.' },
      { id: 'repo', label: 'Repository', placeholder: 'yourname/vibeshare-data', hint: 'The repository Render builds from.' },
      { id: 'branch', label: 'Branch', default: 'main' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'token', label: 'API key', secret: true, hint: 'Account Settings → API Keys.' },
      { id: 'ghToken', label: 'GitHub token', secret: true, hint: 'The access token from the GitHub tab — the client commits each content id with it and Render rebuilds.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.service ?? '').trim()}.onrender.com`, values.folder ?? ''),
    // Wired up: the push pipeline commits to the repository with the GitHub contents API,
    // which makes Render rebuild (and a deploy is asked for besides).
    publish: 'render',
  },
  {
    id: 'appwrite',
    name: 'Appwrite Sites',
    signup: 'https://cloud.appwrite.io/',
    docs: 'https://apppwrite.io/docs/product/sites',
    about: 'Appwrite’s free Hobby plan hosts a site per project and shows its address on the site page. No credit card.',
    steps: [
      {
        title: 'Open the free account and create a project',
        lines: [
          'Sign up at the link below (GitHub, GitLab, email — or “Continue with Google”).',
          'Click “Create project” → name it as below → “Create”.',
        ],
        copies: [{ label: 'Project name', value: 'vibeshare-data' }],
        links: [{ label: 'Appwrite console', url: 'https://cloud.appwrite.io/' }],
        check: 'The console shows your project with a project id under its name.',
      },
      {
        title: 'Create the site',
        lines: [
          'In the left sidebar open “Sites” → “Create site”.',
          'Site name: paste the value below → “Create”.',
        ],
        copies: [{ label: 'Site name', value: 'vibeshare-data' }],
        check: 'The site page is open with a “Deployments” tab and a “Domains” section.',
      },
      {
        title: 'Upload a first build',
        lines: [
          'Download the starter folder (zip) below.',
          'In the site: “Deployments” → “Create deployment” → “Manual upload” → pick the zip → “Deploy”.',
        ],
        copies: [{ label: 'Folder must contain', value: 'index.html' }],
        download: {
          label: 'Download the starter folder (zip)',
          zip: 'VibeShare.zip',
          entries: [{ path: 'VibeShare/index.html', text: STARTER_HTML }],
        },
        check: 'The deployment row shows “Building…” then “Active”.',
      },
      {
        title: 'Copy your base URL',
        lines: ['Open the “Domains” section: the built-in domain is listed there — copy it (it ends in appwrite.site).', 'Paste it into the Base URL field in step 3 below.'],
        check: 'Opening that domain in a new tab shows your index.html.',
      },
      {
        title: 'Create the API key the client pushes with',
        lines: [
          'Left sidebar → “Settings” → “API keys” → “Create API key”.',
          'Name it vibeshare → under “Scopes” select sites.read and sites.write → “Create”.',
          'Copy the secret — it is shown only once.',
        ],
        check: 'You have copied an Appwrite API key secret for the next step.',
      },
    ],
    fields: [
      { id: 'endpoint', label: 'Base URL', placeholder: 'https://vibeshare-data.us-east-1.appwrite.site/', hint: 'Paste the built-in domain from the site’s Domains section (with its trailing slash).' },
      { id: 'project', label: 'Project id', placeholder: 'vibeshare-data', hint: 'Shown under the project name in the console.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'key', label: 'API key', secret: true, hint: 'Settings → API keys → sites.read and sites.write.' },
    ],
    buildBaseUrl: (values) => {
      const endpoint = (values.endpoint ?? '').trim();
      return endpoint ? `${endpoint.replace(/\/+$/, '')}/${(values.folder ?? '').trim().replace(/^\/+|\/+$/g, '')}`.replace(/(.+)\/$/, '$1/') : '';
    },
    // Wired up: the push pipeline creates a deployment with the Sites API
    // (POST /sites/<siteId>/deployments).
    publish: 'appwrite',
  },
  {
    id: 'surge',
    name: 'Surge',
    signup: 'https://surge.sh/',
    docs: 'https://surge.sh/docs',
    about: 'A command-line host since 2014: one command puts a folder online at <name>.surge.sh. Free, no credit card.',
    steps: [
      {
        title: 'Install Node.js (once) and the Surge command',
        lines: [
          'Node.js is the only install: get it from the link below and run the installer with its defaults.',
          'Then paste the command below into a terminal (Applications → Utilities → Terminal).',
        ],
        copies: [{ label: 'Command — install', value: 'npm install --global surge' }],
        links: [{ label: 'Get Node.js', url: 'https://nodejs.org/' }],
        check: 'A terminal run of “surge --version” prints a version number.',
      },
      {
        title: 'Put a page in a folder',
        lines: ['Download and unzip the starter folder below — it holds a site folder with an index.html in it.'],
        copies: [{ label: 'Folder must contain', value: 'index.html' }],
        download: {
          label: 'Download the starter folder (zip)',
          zip: 'site.zip',
          entries: [{ path: 'site/index.html', text: STARTER_HTML }],
        },
        check: 'The folder exists on this device with an index.html inside.',
      },
      {
        title: 'Publish it',
        lines: [
          'Run the command below (replace “site” with the path to your folder — you can also drag the folder onto the terminal window).',
          'The first run asks for an email and a password: pick any — Surge creates the account for you.',
          'When asked for the domain, accept what it suggests or paste your own.',
        ],
        copies: [{ label: 'Command — publish', value: 'surge ./site vibeshare-data.surge.sh' }],
        check: 'The terminal prints “success” and “Uploading complete … Keep on surging!”.',
      },
      {
        title: 'See your site',
        lines: ['Open the address below in a new tab.'],
        copies: [{ label: 'Site address', value: 'https://vibeshare-data.surge.sh/' }],
        check: 'That address opens your index.html.',
      },
      {
        title: 'Get the login token the client pushes with',
        lines: ['Run the command below and copy what it prints (it is your login token, tied to the email you gave).'],
        copies: [{ label: 'Command — print token', value: 'surge token' }],
        check: 'You have copied a token for the next step.',
      },
    ],
    fields: [
      { id: 'domain', label: 'Domain', placeholder: 'vibeshare-data.surge.sh', hint: 'What you published with surge.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'email', label: 'Account email', placeholder: 'you@example.com' },
      { id: 'token', label: 'Login token', secret: true, hint: 'Output of “surge token”.' },
    ],
    buildBaseUrl: (values) => buildUrl((values.domain ?? '').trim().replace(/^https?:\/\//, ''), values.folder ?? ''),
    // Wired up: the push pipeline publishes with the Surge API (POST https://surge.surge.sh
    // with the domain, the file and the login token — the call the surge command makes).
    publish: 'surge',
  },
  {
    id: 'neocities',
    name: 'Neocities',
    signup: 'https://neocities.org/',
    docs: 'https://neocities.org/about',
    about: 'Free static hosting at <site>.neocities.org, uploaded from the browser. No ads, no credit card.',
    steps: [
      {
        title: 'Open the free account',
        lines: [
          'At the link below pick a username and password and enter an email, then “Join Neocities”.',
          'That username is the site address — you keep it for as long as you use it.',
        ],
        copies: [{ label: 'Suggested site name', value: 'vibeshare-data' }],
        links: [{ label: 'Create your site', url: 'https://neocities.org/' }],
        check: 'You are signed in and the site name appears in the top bar.',
      },
      {
        title: 'Upload a first page',
        lines: [
          'Open the “Files” tab of your site.',
          'Click “Upload” → “Choose files” → pick the starter page you downloaded below (or drag it onto the page).',
          'Wait for “File upload complete”.',
        ],
        copies: [{ label: 'File name (must match exactly)', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'The file list shows index.html.',
      },
      {
        title: 'See your site',
        lines: ['Open the address below in a new tab.'],
        copies: [{ label: 'Site address', value: 'https://vibeshare-data.neocities.org/' }],
        check: 'That address opens your index.html.',
      },
      {
        title: 'Create the API key the client pushes with',
        lines: [
          'Open “Settings” → “API Key”.',
          'Click “Generate” and copy the key it prints (letters and numbers).',
        ],
        check: 'You have copied an API key for the next step.',
      },
    ],
    fields: [
      { id: 'site', label: 'Site name', placeholder: 'vibeshare-data', hint: 'The name before .neocities.org.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'apiKey', label: 'API key', secret: true, hint: 'Settings → API Key → Generate.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.site ?? '').trim()}.neocities.org`, values.folder ?? ''),
    // Wired up: the push pipeline posts the file to the Neocities upload API
    // (POST /api/upload with the API key as the bearer token).
    publish: 'neocities',
  },
  {
    id: 'codeberg',
    name: 'Codeberg Pages',
    signup: 'https://codeberg.org/user/sign_up',
    docs: 'https://docs.codeberg.org/',
    about: 'Codeberg is a non-profit Git host (Forgejo) that serves a repository as a site at <user>.pages.codeberg.org. No credit card.',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below (email, username, password) and confirm the address they email you.'],
        links: [{ label: 'Sign up for Codeberg', url: 'https://codeberg.org/user/sign_up' }],
        check: 'You are signed in to codeberg.org.',
      },
      {
        title: 'Create the pages repository',
        lines: [
          'Click “New repository”.',
          'Repository name: paste the value below (the name is what makes Pages serve it).',
          'Visibility: Public. Turn on “Initialize this repository with a README”. Click “Create repository”.',
        ],
        copies: [{ label: 'Repository name', value: 'pages.repo' }],
        check: 'The repository “pages.repo” exists and shows a README.md.',
      },
      {
        title: 'Add the page the site serves',
        lines: ['Download the starter page below.', 'Click “Add file” → “Upload file”, pick the downloaded file, then click “Commit changes”.'],
        copies: [{ label: 'File name', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'index.html is listed in the repository files.',
      },
      {
        title: 'See your site',
        lines: [
          'Wait a minute, then open the address below (replace YOUR-NAME with your Codeberg name).',
          'If it does not open, look at the repository’s “Settings → Pages” — the address it shows there is the right one.',
        ],
        copies: [{ label: 'Site address', value: 'https://YOUR-NAME.pages.codeberg.org/' }],
        check: 'The address opens your index.html.',
      },
      {
        title: 'Create the access token the client pushes with',
        lines: [
          'Click your avatar → “Settings” → “Applications”.',
          'Under “Personal access tokens” paste the name below, tick the “repository” write scope, click “Generate”.',
          'Copy the token now — it is shown only once.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        check: 'You have copied a Codeberg token for the next step.',
      },
    ],
    fields: [
      { id: 'user', label: 'User', placeholder: 'yourname' },
      { id: 'repo', label: 'Repository', default: 'pages.repo' },
      { id: 'branch', label: 'Branch', default: 'main' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'token', label: 'Access token', secret: true, hint: 'Settings → Applications → personal access token with repository write.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.user ?? '').trim()}.pages.codeberg.org`, values.folder ?? ''),
    // Wired up: Codeberg runs Forgejo — the push pipeline commits through its contents
    // API (POST /api/v1/repos/<user>/<repo>/contents/<path>), the same call as GitHub's.
    publish: 'codeberg',
  },
  {
    id: 'aws',
    name: 'AWS',
    signup: 'https://portal.aws.amazon.com/billing/signup',
    docs: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/HostingWebsiteOnS3Setup.html',
    about: 'Amazon S3 hosts a bucket as a website at http://<bucket>.s3-website-<region>.amazonaws.com/ — 5 GB and 20 000 requests a month free. AWS asks for a card at signup.',
    steps: [
      {
        title: 'Create the AWS account',
        lines: [
          'Open the signup link below: email, password, account name.',
          'AWS asks for a payment method even for the free tier — you are charged only past the free limits.',
          'Finish the phone verification, then sign in to the console.',
        ],
        links: [{ label: 'Create an AWS account', url: 'https://portal.aws.amazon.com/billing/signup' }],
        check: 'console.aws.amazon.com shows the Console Home with a search bar at the top.',
      },
      {
        title: 'Create the bucket',
        lines: [
          'Search the console for “S3” and open it → “Create bucket”.',
          'Bucket name: paste the value below (it must be unique across all of AWS). Region: pick one near you.',
          'Scroll to “Block Public Access settings”: untick “Block all public access” and tick the acknowledgement.',
          'Leave the rest as it is → “Create bucket”.',
        ],
        copies: [{ label: 'Bucket name (make it unique)', value: 'vibeshare-data-yourname' }],
        check: 'The bucket is listed under “General purpose buckets”.',
      },
      {
        title: 'Upload a first page',
        lines: [
          'Open the bucket → “Upload” → “Add files” → pick the starter page you downloaded below.',
          'Click “Upload”, wait for “Upload succeeded”, then “Close”.',
        ],
        copies: [{ label: 'File name (must match exactly)', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'The Objects list shows index.html with its size.',
      },
      {
        title: 'Turn the bucket into a website',
        lines: [
          'Open the “Properties” tab → scroll to “Static website hosting” → “Edit”.',
          'Choose “Use this bucket to host a website”.',
          'Index document: index.html. Error document: 404.html. → “Save changes”.',
        ],
        check: 'Static website hosting says “Enabled” and shows an endpoint address.',
      },
      {
        title: 'Let the public read the files',
        lines: [
          'Open the “Permissions” tab → “Bucket policy” → “Edit”.',
          'Paste the whole line below, replace BUCKET with your bucket name, then “Save changes”.',
        ],
        copies: [
          {
            label: 'Bucket policy (replace BUCKET)',
            value: '{"Version":"2012-10-17","Statement":[{"Sid":"PublicRead","Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::BUCKET/*"}]}',
          },
        ],
        check: 'The saved bucket policy shows the PublicRead statement.',
      },
      {
        title: 'Copy your base URL',
        lines: [
          '“Properties” → bottom of the page → “Static website hosting” → copy the “Bucket website endpoint”.',
          'It starts with http:// (S3 websites have no HTTPS) and ends with a slash — that is your base URL.',
        ],
        copies: [{ label: 'Site address (replace the two parts)', value: 'http://BUCKET.s3-website-REGION.amazonaws.com/' }],
        check: 'That address opens your index.html in a new tab.',
      },
    ],
    fields: [
      { id: 'bucket', label: 'Bucket name', placeholder: 'vibeshare-data-yourname' },
      { id: 'region', label: 'Region', placeholder: 'eu-west-1', hint: 'The region you chose when creating the bucket.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'accessKeyId', label: 'Access key id', placeholder: 'AKIA…', secret: true, hint: 'IAM → Users → Security credentials → Create access key.' },
      { id: 'secretAccessKey', label: 'Secret access key', secret: true, hint: 'Shown once, together with the access key id.' },
    ],
    buildBaseUrl: (values) => {
      const bucket = (values.bucket ?? '').trim();
      const region = (values.region ?? '').trim();
      const folder = (values.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
      if (!bucket || !region) return '';
      return `http://${bucket}.s3-website-${region}.amazonaws.com/${folder ? `${folder}/` : ''}`;
    },
    // Wired up: the push pipeline puts each content id into the bucket (S3 Upload, or a
    // signed PUT against the endpoint with the access keys).
    publish: 'aws',
  },
  {
    id: 'azure',
    name: 'Azure',
    signup: 'https://azure.microsoft.com/free/',
    docs: 'https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-static-website',
    about: 'Azure Blob Storage serves a container as a website at https://<account>.…web.core.windows.net/ — 5 GB free a year. Azure asks for a card at signup.',
    steps: [
      {
        title: 'Create the free account',
        lines: [
          'Open the link below: “Start free”, sign in with a Microsoft account and fill in the short form (a card is required, you stay within the free offer).',
          'Skip the optional surveys until you reach the Azure portal.',
        ],
        links: [{ label: 'Start free on Azure', url: 'https://azure.microsoft.com/free/' }],
        check: 'portal.azure.com shows the Azure portal with “Create a resource” at the top left.',
      },
      {
        title: 'Create the storage account',
        lines: [
          '“Create a resource” → search “Storage account” → “Create”.',
          'Subscription: Free trial. Resource group: “Create new”, name it vibeshare-data → OK.',
          'Storage account name: paste the value below (lowercase, globally unique, 3–24 characters).',
          'Performance: Standard. Redundancy: LRS. → “Review + create” → “Create”.',
        ],
        copies: [{ label: 'Storage account name', value: 'vibesharedata' }],
        check: 'The deployment says “Your deployment is complete” and you can click “Go to resource”.',
      },
      {
        title: 'Turn on the static website',
        lines: [
          'In the storage account open “Settings” → “Static website” → “Enabled”.',
          'Index document name: index.html → “Save”.',
          'Copy the “Primary endpoint” that appears — it ends with a slash.',
        ],
        copies: [{ label: 'Primary endpoint (example — use yours)', value: 'https://vibesharedata.z13.web.core.windows.net/' }],
        check: 'A primary endpoint address is shown under the enable switch.',
      },
      {
        title: 'Upload a first page',
        lines: [
          'Open “Data storage” → “Containers” → the container named $web (it was just created).',
          '“Upload” → “Browse for files” → pick the starter page you downloaded below → “Upload”.',
        ],
        copies: [{ label: 'File name (must match exactly)', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'The $web container lists index.html.',
      },
      {
        title: 'See your site',
        lines: ['Open the primary endpoint from step 3 in a new tab.'],
        check: 'That address opens your index.html.',
      },
      {
        title: 'Create the access the client pushes with',
        lines: [
          'In the storage account open “Settings” → “Access keys”.',
          'Show key1 and copy its “Key” value (or the connection string).',
        ],
        check: 'You have copied a 52-character key for the next step.',
      },
    ],
    fields: [
      { id: 'endpoint', label: 'Primary endpoint', placeholder: 'https://vibesharedata.z13.web.core.windows.net/', hint: 'Static website → Primary endpoint (with its trailing slash).' },
      { id: 'account', label: 'Storage account name', placeholder: 'vibesharedata' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'key', label: 'Access key', secret: true, hint: 'Settings → Access keys → key1.' },
    ],
    buildBaseUrl: (values) => {
      const endpoint = (values.endpoint ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const account = (values.account ?? '').trim();
      const host = endpoint || (account ? `${account}.z13.web.core.windows.net` : '');
      const folder = (values.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
      return host ? `https://${host}/${folder ? `${folder}/` : ''}` : '';
    },
    // Wired up: the push pipeline puts each content id into the $web container
    // (PUT https://<account>.blob.core.windows.net/$web/<path> with the access key).
    publish: 'azure',
  },
  {
    id: 'gcloud',
    name: 'Google Cloud',
    signup: 'https://console.cloud.google.com/',
    docs: 'https://cloud.google.com/storage/docs/hosting-static-website',
    about: 'A Cloud Storage bucket served as a website at https://storage.googleapis.com/<bucket>/ — 5 GB free a month. Google asks for a card on the free trial.',
    steps: [
      {
        title: 'Create the free account and a project',
        lines: [
          'Open the link below: “Get started for free”, sign in with Google, fill in the short form (a card is required, the trial starts with credit).',
          'In the console, click the project selector (top left) → “New project”.',
          'Project name: paste the value below → “Create”.',
        ],
        copies: [{ label: 'Project name', value: 'vibeshare-data' }],
        links: [{ label: 'Start free on Google Cloud', url: 'https://console.cloud.google.com/' }],
        check: 'The project selector at the top shows your new project as the current one.',
      },
      {
        title: 'Create the bucket',
        lines: [
          'Open “Cloud Storage” → “Buckets” → “Create bucket”.',
          'Name: paste the value below (globally unique) → “Continue”.',
          'Location type: “Region” (pick one near you) → “Continue”.',
          'Storage class: “Standard” → Continue. Access control: “Uniform” → “Continue”. Everything else as it is → “Create”.',
        ],
        copies: [{ label: 'Bucket name (make it unique)', value: 'vibeshare-data-yourname' }],
        check: 'The bucket page opens and shows its “Objects” tab.',
      },
      {
        title: 'Upload a first page',
        lines: ['In the bucket click “Upload files”.', 'Pick the starter page you downloaded below → “Upload”.'],
        copies: [{ label: 'File name (must match exactly)', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'The Objects list shows index.html.',
      },
      {
        title: 'Let the public read the files',
        lines: [
          'Open the “Permissions” tab → “Public access prevention”: set it to “Inherited” if it says “Enforced”.',
          'Click “Grant access”. New principals: type allUsers. Role: search and pick “Storage Object Viewer”.',
          'Click “Save”, then “Allow” if it warns about public access.',
        ],
        copies: [
          { label: 'Principal', value: 'allUsers' },
          { label: 'Role', value: 'Storage Object Viewer' },
        ],
        check: 'The permissions list has a row: allUsers · Storage Object Viewer.',
      },
      {
        title: 'Turn the bucket into a website',
        lines: [
          'Open the “Settings” tab → “Static website” → “Edit”.',
          'Index page: index.html. Error page (optional): 404.html → “Save”.',
        ],
        copies: [{ label: 'Index page', value: 'index.html' }],
        check: 'Static website shows “On” and a “Website endpoint”.',
      },
      {
        title: 'Copy your base URL',
        lines: ['Copy the website endpoint shown under Settings → Static website (it ends with a slash).'],
        copies: [{ label: 'Site address (replace BUCKET)', value: 'https://storage.googleapis.com/BUCKET/' }],
        check: 'That address opens your index.html in a new tab.',
      },
    ],
    fields: [
      { id: 'bucket', label: 'Bucket name', placeholder: 'vibeshare-data-yourname' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'accessKey', label: 'HMAC access key id', secret: true, hint: 'Settings → Interoperability → “Create HMAC key” (service account key for storage).' },
      { id: 'secret', label: 'HMAC secret', secret: true, hint: 'Shown once, with the access key id.' },
    ],
    buildBaseUrl: (values) => {
      const bucket = (values.bucket ?? '').trim();
      const folder = (values.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
      if (!bucket) return '';
      return `https://storage.googleapis.com/${bucket}/${folder ? `${folder}/` : ''}`;
    },
    // Wired up: the push pipeline uploads each content id with the JSON API
    // (POST https://storage.googleapis.com/upload/storage/v1/b/<bucket>/o).
    publish: 'gcloud',
  },
];
/**
 * The three steps every platform shares after the account setup — each platform fills
 * them in with its own words about where the files land and how to see them.
 */
function urlGuide(lands: string, verify: string): HostingStep[] {
  return [
    {
      title: 'Read the base URL',
      lines: [
        'The field below was filled in from your answers; if the platform shows another address, type over it — it is editable.',
        lands,
      ],
      check: 'The Base URL field starts with http:// or https:// and ends with a slash.',
    },
    {
      title: 'Pick the content id to host',
      lines: [
        'Fetch the ids your providers are waiting for (below), or paste one by hand — it fills the Content id field.',
        verify,
      ],
      check: 'The Content id field holds an id and the example address under it shows that id at the end.',
    },
  ];
}

/** Saving the host, offering it to provider nodes, and putting the job's bytes on the site. */
function saveGuide(push: string): HostingStep[] {
  return [
    {
      title: 'Save this host and offer it to your providers',
      lines: [
        'Give it a name you recognise later (the tab label), then press the button below: it saves the host on this device and gives its base URL to your provider nodes in one go.',
        'Each provider now queries <base>/<cid> for any content id it is asked for, and pays credits when the bytes hash to the id.',
      ],
      check: 'A toast says “Saved …”, then “Offered … to N provider node(s)”.',
    },
    {
      title: 'Put the job’s bytes on the site',
      lines: [push],
      check: 'The bytes of that content id are served at <base>/<cid> — the provider can download and pay for them.',
    },
  ];
}
/** What the wizard shows after the account setup, per platform. */
export interface PlatformGuide {
  /** Where each access detail comes from, one step per field group. */
  access: HostingStep[];
  /** The base URL and content ids of this platform. */
  url: HostingStep[];
  /** Saving the host, offering it and pushing the job's bytes. */
  save: HostingStep[];
}

export const PLATFORM_GUIDES: Record<string, PlatformGuide> = {
  github: {
    access: [
      {
        title: 'Where the repository lives',
        lines: ['Open your repository in a browser: the address reads github.com/OWNER/REPO.', 'Owner and Repository are those two parts, typed exactly as shown.'],
        fields: ['owner', 'repo'],
        check: 'Owner and Repository match the address of your repository page.',
      },
      {
        title: 'Which branch Pages publishes',
        lines: ['Open Settings → Pages in the repository: the “Branch” line shows it (usually main, folder / (root)).'],
        fields: ['branch'],
        check: 'The Branch field holds the same name Settings → Pages shows.',
      },
      {
        title: 'Where content ids go',
        lines: ['The client commits every content id into this folder: <folder>/<cid>.', 'Leave it empty to put them at the repository root instead.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The access token',
        lines: [
          'Avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → “Generate new token”.',
          'Token name vibeshare · Repository access: “Only select repositories” → your repository · Repository permissions → Contents: Read and write.',
          'Copy it now (it starts with github_pat_) and paste it below — GitHub shows it only once.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field is filled (dots) with a github_pat_ token.',
      },
    ],
    url: urlGuide(
      'On GitHub Pages the folder is a real directory in your repository: the client commits <folder>/<cid> and Pages serves it about a minute later.',
      'Open the example address in a browser — before the first push it answers 404, after it shows the bytes.'
    ),
    save: saveGuide(
      'The GitHub push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and commits it with the token.'
    ),
  },
  cloudflare: {
    access: [
      {
        title: 'The account id',
        lines: ['Open Workers & Pages: the account id is the 32-character string in the page address (dash.cloudflare.com/<account-id>/workers) or in the sidebar.'],
        fields: ['account'],
        check: 'The Account id field holds 32 characters with no spaces.',
      },
      {
        title: 'The project name',
        lines: ['Workers & Pages → your project: its address is <project>.pages.dev.'],
        fields: ['project'],
        check: 'The Project name matches the address you opened in step 2.',
      },
      {
        title: 'Where content ids go',
        lines: ['The client uploads each content id as <folder>/<cid> in that project. Leave the folder empty to use the site root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The API token',
        lines: [
          'Profile icon → My Profile → API Tokens → “Create Token”.',
          'Name it vibeshare · Permissions: Account · Cloudflare Pages · Edit · Account Resources: your account → “Continue to summary” → “Create Token”.',
          'Copy the secret (it starts with cfut_) — Cloudflare shows it only once.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The API token field is filled with a cfut_ token.',
      },
    ],
    url: urlGuide(
      'Cloudflare Pages serves the project’s assets at <project>.pages.dev: each push becomes a deployment, and <folder>/<cid> is the path inside it.',
      'Open the example address — 404 until the first deployment, the bytes after it.'
    ),
    save: saveGuide(
      'The Cloudflare push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and uploads it with the direct upload API (POST /accounts/<account>/pages/projects/<project>/deployments).'
    ),
  },
  gitlab: {
    access: [
      {
        title: 'Where the project lives',
        lines: ['Open your project: the address reads gitlab.com/NAMESPACE/PROJECT. The namespace is your user or group path.'],
        fields: ['namespace', 'project'],
        check: 'Namespace and Project match the address of your project page.',
      },
      {
        title: 'Which branch the pipeline runs on',
        lines: ['Open Manage → Repository → Branches: the branch with the pages job is the one to use (new projects start on main).'],
        fields: ['branch'],
        check: 'The Branch field matches the branch your .gitlab-ci.yml was committed to.',
      },
      {
        title: 'Where content ids go',
        lines: [
          'The client commits each content id as <folder>/<cid> — with the folder below as public, that is public/<cid>.',
          'Pages publishes that folder as the site root, so the file is served at /<cid>: the folder name is not part of the address.',
        ],
        fields: ['folder'],
        check: 'The folder field says public — the folder Pages publishes, and the one your index.html sits in.',
      },
      {
        title: 'The access token',
        lines: [
          'Avatar → Edit profile → Access → Personal access tokens → “Generate token” → Legacy token.',
          'Name it vibeshare · scopes: api (read-write, needed to commit files) and write_repository · “Generate token”.',
          'Copy it now — GitLab shows it only once, then only as a prefix.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field is filled with a glpat- token.',
      },
    ],
    url: urlGuide(
      'GitLab Pages publishes the folder below (public) as the site root: a file at public/<cid> is served at /<cid>. The folder never appears in the address — a URL that still contains public/ answers 404, and GitLab may redirect the project site to a unique <project>-<hash>.gitlab.io address (the same site). The base URL under the field is exactly what providers will query.',
      'Open the example address — 404 until the commit below is pushed and the pipeline turns green. Never put the folder in the address.'
    ),
    save: saveGuide(
      'The GitLab push is wired end to end: press “Publish the job’s content id to this host & save” — it commits <folder>/<cid> (public/<cid>) with your token and Pages serves it about a minute later.'
    ),
  },
  netlify: {
    access: [
      {
        title: 'The project name',
        lines: ['Open the site → Site configuration → “Change site name”: the address is <name>.netlify.app. The name you typed in the first tab is already here.'],
        fields: ['site'],
        check: 'The Project name field matches the address of your site.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each push becomes a deploy; <folder>/<cid> is the path inside the deployed folder. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The access token',
        lines: [
          'Click your avatar in the left panel at the bottom left → “User settings” → “Applications” → “Personal access tokens” → “Generate new token”.',
          'Name it vibeshare, set the expiration date for this token to whatever timespan you would like, then “Generate”.',
          'Copy it now (it starts with nfp_) — Netlify shows it only once. The token you pasted in the first tab is already here.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field is filled with an nfp_ token.',
      },
      {
        title: 'Set the site’s deploy settings',
        lines: [
          'Open Site configuration → Build & deploy → Build settings: clear the Build command (it must be empty) and leave the Publish directory empty or “/”. This site is pushed whole — a build would replace the files the push put there.',
          'On the same page → Post processing → Asset optimization: switch it off — it rewrites the files the push uploads.',
          'Do not connect a Git repository to this site. Deploys come from the push; a site that builds from a repository replaces what the push put there.',
          'After a push, wait until Deploys shows the deploy as “Published” before checking the content id path — it can take about a minute.',
        ],
        check: 'Build command is empty, asset optimization is off, and no Git repository is connected to the site.',
      },
    ],
    url: urlGuide(
      'Netlify serves the deployed folder at <site>.netlify.app: a push redeploys, and <folder>/<cid> is the path inside it.',
      'Open the example address — 404 until a deploy carries the file.'
    ),
    save: saveGuide(
      'The Netlify push is wired end to end: press “Publish the job’s content id to this host & save” — it deploys <folder>/<cid> with the files API (POST https://api.netlify.com/api/v1/sites/<site>/deploys), carrying over everything the site already serves so nothing is dropped, and the deploy publishes by itself. The starter folder (the download button in the first tab) is the manual alternative: drag it into the Deploys page once and pushes add to what it set up.'
    ),
  },
  vercel: {
    access: [
      {
        title: 'Where content ids go',
        lines: ['Each push deploys the folder; <folder>/<cid> is the path inside it. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'Create the access token the client pushes with',
        lines: [
          'Avatar → “Account Settings” → “Tokens” (or open the Tokens link below).',
          '“Create Token” → name it vibeshare → set a scope if asked → “Create”.',
          'Copy it now — it is shown only once.',
        ],
        links: [{ label: 'Tokens page', url: 'https://vercel.com/account/tokens' }],
        fields: ['token'],
        check: 'The Access token field is filled with a vcp_ token.',
      },
    ],
    url: urlGuide(
      'Vercel serves the deployed folder at <project>.vercel.app: each push is a new deployment, and <folder>/<cid> is the path inside it.',
      'Open the example address — 404 until a deployment carries the file.'
    ),
    save: saveGuide(
      'The Vercel push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and creates a deployment with the REST API (POST https://api.vercel.com/v13/deployments), reusing the copies Vercel already holds.'
    ),
  },
  firebase: {
    access: [
      {
        title: 'The project id',
        lines: ['Firebase console → your project → Project settings → General: “Project ID” is the id (letters, digits and dashes).'],
        fields: ['project'],
        check: 'The Project id field matches Project settings → General → Project ID.',
      },
      {
        title: 'Where content ids go',
        lines: ['The client adds <folder>/<cid> to a Hosting release, so the site serves it under the project address. Leave the folder empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The service account key',
        lines: [
          'Project settings (gear icon) → “Service accounts”.',
          '“Generate new private key” → “Generate key”: a JSON file downloads.',
          'Paste the whole file contents below (it is a secret — it can deploy for you).',
        ],
        copies: [{ label: 'Where to click', value: 'Project settings → Service accounts → Generate new private key' }],
        fields: ['key'],
        check: 'The Service account key field is filled with the JSON from that download.',
      },
    ],
    url: urlGuide(
      'Firebase Hosting serves a release at <project>.web.app: <folder>/<cid> is a file inside the release, published by “firebase deploy”.',
      'Open the example address — 404 until a deploy carries the file.'
    ),
    save: saveGuide(
      'The Firebase push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers, uploads it as a Hosting version and releases it (POST /v1beta1/sites/<site>/versions, then a release).'
    ),
  },
  render: {
    access: [
      {
        title: 'The site name',
        lines: ['Open the site → “Settings” → “Name”: the address is <name>.onrender.com.'],
        fields: ['service'],
        check: 'The Site name matches the address of your site.',
      },
      {
        title: 'The repository it builds',
        lines: ['The repository is owner/name as it appears in GitHub (e.g. yourname/vibeshare-data).'],
        fields: ['repo'],
        check: 'The Repository field holds owner/name of the connected repository.',
      },
      {
        title: 'The branch it builds',
        lines: ['The branch Render deploys is the one the repository pushes to (usually main).'],
        fields: ['branch'],
        check: 'The Branch field holds the branch your repository uses.',
      },
      {
        title: 'Where content ids go',
        lines: ['Render rebuilds the repository on every push; <folder>/<cid> is the path inside the publish directory. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The API key',
        lines: [
          'Avatar → “Account Settings” → “API Keys” → “Create API Key”.',
          'Name it vibeshare → “Create”. Copy it now — it is shown only once.',
        ],
        copies: [{ label: 'Key name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The API key field is filled.',
      },
      {
        title: 'The GitHub token the client commits with',
        lines: [
          'The client commits each content id into the repository and Render rebuilds — that needs a GitHub token with Contents: Read and write on that repository.',
          'The token you made in the GitHub tab works here (fine-grained, that repository, Contents: Read and write).',
        ],
        fields: ['ghToken'],
        check: 'The GitHub token field is filled (dots).',
      },
    ],
    url: urlGuide(
      'Render serves the publish directory at <service>.onrender.com: <folder>/<cid> is a file in that directory, published by the next build.',
      'Open the example address — 404 until a build carries the file.'
    ),
    save: saveGuide(
      'The Render push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and commits <folder>/<cid> to the repository (the same contents API as GitHub), which makes Render rebuild.'
    ),
  },
  appwrite: {
    access: [
      {
        title: 'The base URL',
        lines: [
          'Open the site → “Domains”: the built-in domain is listed there (it ends in appwrite.site).',
          'Copy it into the field with its trailing slash — this is the address the whole panel uses.',
        ],
        fields: ['endpoint'],
        check: 'The Base URL field holds the built-in domain from the Domains section.',
      },
      {
        title: 'The project id',
        lines: ['The console shows the project id directly under the project name (Settings → General too).'],
        fields: ['project'],
        check: 'The Project id field matches the id under the project name.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each push becomes a deployment of the site; <folder>/<cid> is the path inside it. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The API key',
        lines: [
          'Left sidebar → “Settings” → “API keys” → “Create API key”.',
          'Name it vibeshare · Scopes: sites.read and sites.write → “Create”.',
          'Copy the secret now — Appwrite shows it only once.',
        ],
        copies: [{ label: 'Key name', value: 'vibeshare' }],
        fields: ['key'],
        check: 'The API key field is filled with a secret that starts with standard_.',
      },
    ],
    url: urlGuide(
      'Appwrite Sites serves each deployment at the site’s built-in domain: <folder>/<cid> is the path inside the deployment.',
      'Open the example address — 404 until a deployment carries the file.'
    ),
    save: saveGuide(
      'The Appwrite push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and creates a deployment for the site (POST /sites/<siteId>/deployments).'
    ),
  },
  surge: {
    access: [
      {
        title: 'The domain you published',
        lines: ['The domain is what you typed when Surge asked for it (usually <name>.surge.sh), without https://.'],
        fields: ['domain'],
        check: 'The Domain field matches what “surge” printed when it finished.',
      },
      {
        title: 'Where content ids go',
        lines: ['Running surge inside a folder publishes its files; <folder>/<cid> is the path inside that folder.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The account it publishes as',
        lines: ['The email you gave on the first “surge” run is your account.'],
        fields: ['email'],
        check: 'The Account email is the address you signed up with.',
      },
      {
        title: 'The login token',
        lines: ['Run the command below in a terminal and copy what it prints.'],
        copies: [{ label: 'Command — print token', value: 'surge token' }],
        fields: ['token'],
        check: 'The Login token field is filled.',
      },
    ],
    url: urlGuide(
      'Surge serves the folder you publish at <domain>: <folder>/<cid> is a file inside it, published by the next “surge” run.',
      'Open the example address — 404 until you publish that file.'
    ),
    save: saveGuide(
      'The Surge push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and deploys the file with the Surge API (POST https://surge.surge.sh — domain, file, token).'
    ),
  },
  neocities: {
    access: [
      {
        title: 'The site name',
        lines: ['The site name is the part before .neocities.org in your site’s address.'],
        fields: ['site'],
        check: 'The Site name matches the address you opened in step 2.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each push uploads a file; <folder>/<cid> is the path inside your site. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The API key',
        lines: ['Open “Settings” → “API Key”.', 'Click “Generate” and copy the key it prints — it authorises uploads for this site.'],
        fields: ['apiKey'],
        check: 'The API key field is filled.',
      },
    ],
    url: urlGuide(
      'Neocities serves the files you uploaded at <site>.neocities.org: <folder>/<cid> is a file path in your site.',
      'Open the example address — 404 until you upload that file.'
    ),
    save: saveGuide(
      'The Neocities push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and posts the file to the upload API (POST https://neocities.org/api/upload, bearer token).'
    ),
  },
  codeberg: {
    access: [
      {
        title: 'The user it is served under',
        lines: ['Your Codeberg name is the first part of the address: <user>.pages.codeberg.org.'],
        fields: ['user'],
        check: 'The User field is your Codeberg name.',
      },
      {
        title: 'The repository and branch',
        lines: ['The pages repository is pages.repo on the branch you pushed (usually main).'],
        fields: ['repo', 'branch'],
        check: 'Repository says pages.repo and the branch matches what you pushed.',
      },
      {
        title: 'Where content ids go',
        lines: ['The client commits <folder>/<cid> into pages.repo; Codeberg Pages serves it at that path. Leave the folder empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The access token',
        lines: [
          'Avatar → “Settings” → “Applications”.',
          'Under “Personal access tokens” name it vibeshare, tick the repository write scope, “Generate”.',
          'Copy it now — Codeberg shows it only once.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field is filled.',
      },
    ],
    url: urlGuide(
      'Codeberg Pages serves pages.repo at <user>.pages.codeberg.org: <folder>/<cid> is a file in that repository.',
      'Open the example address — 404 until the next commit carries the file.'
    ),
    save: saveGuide(
      'The Codeberg push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and commits through the Forgejo contents API (POST /api/v1/repos/<user>/<repo>/contents/<path>), the same call GitHub uses.'
    ),
  },
  aws: {
    access: [
      {
        title: 'The bucket and its region',
        lines: ['Open the bucket → “Properties”: “AWS Region” is the region, the name is at the top.', 'Both must match exactly: the address is built from them.'],
        fields: ['bucket', 'region'],
        check: 'Bucket name and Region are the ones shown on the bucket’s Properties page.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each content id is an object key <folder>/<cid> in the bucket. Leave the folder empty to write at the top level.'],
        fields: ['folder'],
        check: 'The folder field says where the objects will land.',
      },
      {
        title: 'The access keys',
        lines: [
          'IAM console (console.aws.amazon.com/iam) → “Users” → “Create user” → name vibeshare → “Next”.',
          'Attach the policy “AmazonS3FullAccess” → “Create user”.',
          'Open the user → “Create access key” → “Command Line Interface” → “Next” → “Create access key”.',
          'Copy the access key id and the secret (the secret is shown only once) into the two fields.',
        ],
        copies: [{ label: 'Policy to attach', value: 'AmazonS3FullAccess' }],
        fields: ['accessKeyId', 'secretAccessKey'],
        check: 'Both key fields are filled — access key id starts with AKIA.',
      },
    ],
    url: urlGuide(
      'The S3 website endpoint serves objects by key: <folder>/<cid> is an object in the bucket. Note it is plain http:// — S3 websites have no HTTPS.',
      'Open the example address — before the first upload it answers 404 (or NoSuchKey), after it the bytes.'
    ),
    save: saveGuide(
      'The AWS push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and puts the object in the bucket (PUT /<folder>/<cid> against the endpoint, signed with the access keys).'
    ),
  },
  azure: {
    access: [
      {
        title: 'The primary endpoint',
        lines: [
          'In the storage account open “Settings” → “Static website”: the “Primary endpoint” is the address (it ends with a slash).',
          'Paste it below — it already names your account and region, so nothing else needs typing.',
        ],
        fields: ['endpoint'],
        check: 'The Primary endpoint field holds the address shown under the switch.',
      },
      {
        title: 'The storage account name',
        lines: ['The name is the first part of the endpoint (before .z…web.core.windows.net) and the name you chose when creating the account.'],
        fields: ['account'],
        check: 'The Storage account name matches the endpoint above it.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each content id is a blob in the $web container at <folder>/<cid>. Leave the folder empty for the container root.'],
        fields: ['folder'],
        check: 'The folder field says where the blobs will land.',
      },
      {
        title: 'The access key',
        lines: [
          'In the storage account: “Settings” → “Access keys”.',
          'Show key1 and copy its “Key” value (52 characters) into the field below.',
        ],
        copies: [{ label: 'Where to click', value: 'Settings → Access keys → key1 → Show' }],
        fields: ['key'],
        check: 'The Access key field is filled with a 52-character key.',
      },
    ],
    url: urlGuide(
      'Azure serves the $web container at the primary endpoint: <folder>/<cid> is a blob path in that container, visible as soon as it is uploaded.',
      'Open the example address — 404 until the blob is uploaded.'
    ),
    save: saveGuide(
      'The Azure push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and puts the blob in $web (PUT https://<account>.blob.core.windows.net/$web/<path> with the access key).'
    ),
  },
  gcloud: {
    access: [
      {
        title: 'The bucket',
        lines: ['Open the bucket: its name is at the top of the page (globally unique, no https://).'],
        fields: ['bucket'],
        check: 'The Bucket name matches the bucket you opened.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each content id is an object <folder>/<cid> in the bucket. Leave the folder empty to write at the top level.'],
        fields: ['folder'],
        check: 'The folder field says where the objects will land.',
      },
      {
        title: 'The HMAC keys',
        lines: [
          'Cloud Storage → “Settings” → “Interoperability” → “HMAC keys for service accounts” → “Create HMAC key”.',
          'Pick a service account (or create one) → “Create”.',
          'Copy the HMAC access id and the secret — the secret is shown only once — into the two fields.',
        ],
        copies: [{ label: 'Where to click', value: 'Cloud Storage → Settings → Interoperability → Create HMAC key' }],
        fields: ['accessKey', 'secret'],
        check: 'Both key fields are filled (the access id is 20 characters).',
      },
    ],
    url: urlGuide(
      'The bucket’s website endpoint serves objects by key: <folder>/<cid> is an object in the bucket, readable by anyone because allUsers may view objects.',
      'Open the example address — 404 (or AccessDenied until the object is public) before the first upload, the bytes after it.'
    ),
    save: saveGuide(
      'The Google Cloud push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and uploads the object (POST https://storage.googleapis.com/upload/storage/v1/b/<bucket>/o, signed with the HMAC keys).'
    ),
  },
};

/** The guide behind the wizard’s last three steps; every platform has one. */
export function platformGuide(id: string): PlatformGuide {
  return PLATFORM_GUIDES[id] ?? PLATFORM_GUIDES.github;
}
export function hostingPlatform(id: string): HostingPlatform {
  return HOSTING_PLATFORMS.find((platform) => platform.id === id) ?? HOSTING_PLATFORMS[0];
}

// ---------------------------------------------------------------------- saved hosts

const HOSTS_KEY = 'vibeshare-earn-hosts';

export function loadHosts(): HostConfig[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(HOSTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as HostConfig[]) : [];
    return Array.isArray(parsed) ? parsed.filter((host) => host && typeof host.baseUrl === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHosts(hosts: HostConfig[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
  } catch {
    // The list still works for this visit when storage is unavailable.
  }
}

export function newHostId(): string {
  return `h-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------- URL jobs

/**
 * One job this client took: its bytes are hosted at the data hosting URLs (nothing is
 * kept on this machine) and the provider gets the full retrieved data from those URLs.
 * Entries appear only when the user actively creates or selects a job in the Provider
 * jobs tab or uploads it with the URL jobs card — never automatically.
 */
export interface UrlJobEntry {
  id: string;
  cid: string;
  title?: string;
  /** The provider node the job came from. */
  source: string;
  /** Host labels the bytes were uploaded to. */
  hosts: string[];
  /** The URL that serves the full retrieved data. */
  url: string;
  at: string;
}

const URL_JOBS_KEY = 'vibeshare-earn-urljobs';

export function loadUrlJobs(): UrlJobEntry[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(URL_JOBS_KEY);
    const parsed = raw ? (JSON.parse(raw) as UrlJobEntry[]) : [];
    return Array.isArray(parsed) ? parsed.filter((job) => job && typeof job.cid === 'string') : [];
  } catch {
    return [];
  }
}

export function saveUrlJobs(jobs: UrlJobEntry[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(URL_JOBS_KEY, JSON.stringify(jobs));
  } catch {
    // The list still works for this visit when storage is unavailable.
  }
}

/** Adds newly uploaded jobs newest-first, keeping one row per content id. */
export function recordUrlJobs(entries: UrlJobEntry[]): UrlJobEntry[] {
  const current = loadUrlJobs();
  const merged = [...entries, ...current.filter((job) => !entries.some((entry) => entry.cid === job.cid))];
  saveUrlJobs(merged);
  return merged;
}

// ---------------------------------------------------------------------- step drafts

/** What the setup wizard holds between visits: every field, per platform. */
export interface HostDraft {
  values: Record<string, string>;
  /** Which steps are ticked off, per step group (account/access/url/save): the checklist survives a reload. */
  done?: Record<string, boolean[]>;
  /** The manually edited base URL (empty = built from the fields). */
  baseUrl: string;
  label: string;
  cid: string;
}

const DRAFTS_KEY = 'vibeshare-earn-drafts';

export function loadDrafts(): Record<string, HostDraft> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, HostDraft>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Saves every step's fields as they are typed — nothing is lost between steps. */
export function saveDrafts(drafts: Record<string, HostDraft>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // The drafts still work for this visit when storage is unavailable.
  }
}

// ---------------------------------------------------------------------- pushing job data

const PUSHED_KEY = 'vibeshare-earn-pushed';

/** What a host already carries: its id → every path inside the site → its digest and size. */
export function loadPushed(hostId: string): Record<string, { hash: string; size: number }> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PUSHED_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, { hash: string; size: number }>>) : {};
    return parsed[hostId] ?? {};
  } catch {
    return {};
  }
}

/** Remembers the files a deployment now carries, so the next one can keep referencing them. */
export function savePushed(hostId: string, files: Record<string, { hash: string; size: number }>): void {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PUSHED_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, { hash: string; size: number }>>) : {};
    parsed[hostId] = files;
    if (typeof localStorage !== 'undefined') localStorage.setItem(PUSHED_KEY, JSON.stringify(parsed));
  } catch {
    // Losing the list only costs a re-upload next time.
  }
}

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
  // The folder (public by default) is the one Pages publishes, so <folder>/<cid> in the
  // repository is served at /<cid> — it never appears in the address.
  const path = contentPath(host.values, cid);
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
      message: `Could not reach gitlab.com (${why}). Check the connection and the token, or commit public/${path.split('/').slice(1).join('/')} by hand in the repository.`,
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