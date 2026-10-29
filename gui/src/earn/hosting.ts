// Free static hosting platforms provider jobs can push content to. Each platform shows
// how to open an account and publish a base URL; the GUI builds that base URL from the
// entered values and appends content ids to it, so providers can query `<base>/<cid>`.
// Pushing job data to a site is wired up for GitHub Pages (the example) and sketched for
// the others: each entry says which API its pipeline calls once it is connected.

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
  steps: string[];
  fields: HostingField[];
  /** The default published base URL from the entered values (with its trailing slash). */
  buildBaseUrl: (values: Record<string, string>) => string;
  /** Push pipeline that is wired up today; the others are skeletons. */
  publish?: 'github';
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


export const HOSTING_PLATFORMS: HostingPlatform[] = [
  {
    id: 'github',
    name: 'GitHub Pages',
    signup: 'https://github.com/signup',
    docs: 'https://docs.github.com/en/pages',
    about: 'A free GitHub account serves a repository as a static site at <user>.github.io.',
    steps: [
      'Open a free GitHub account and create a public repository (any name, e.g. “vibeshare-data”; a repository named exactly <user>.github.io publishes at the root).',
      'Add an index.html (even an empty one) and push it to the default branch.',
      'In the repository: Settings → Pages → Source: “Deploy from a branch” → pick the branch and root → Save.',
      'Wait a minute and open https://<user>.github.io/<repo>/ — that is your base URL.',
      'Create an access token: your avatar → Settings → Developer settings → Fine-grained tokens → new token → only this repository → Repository permissions → Contents: Read and write.',
      'Fill in the fields below. The client pushes each content id as a file in the folder, so the site serves <base>/<cid> right after the push.',
    ],
    fields: [
      { id: 'owner', label: 'User or organization', placeholder: 'yourname', hint: 'The account that owns the repository.' },
      { id: 'repo', label: 'Repository', placeholder: 'vibeshare-data', hint: 'Public, with GitHub Pages enabled.' },
      { id: 'branch', label: 'Branch', default: 'main', hint: 'The branch Pages deploys from.' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl', hint: 'Files land at <folder>/<cid>; leave empty for the repository root.' },
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
    about: 'Free static sites on a <project>.pages.dev address with unlimited bandwidth.',
    steps: [
      'Open a free Cloudflare account and create a Pages project (Workers & Pages → Create → Pages → Upload assets or connect a repository).',
      'Name the project: the site appears at https://<project>.pages.dev once the first deploy is up.',
      'In My Profile → API Tokens create a token with Account → Cloudflare Pages: Edit for the account.',
      'Fill in the fields below and adjust the base URL if your project serves from a custom domain.',
    ],
    fields: [
      { id: 'account', label: 'Account id', placeholder: '1f3a…', hint: 'Account → Workers & Pages → the account id in the URL or sidebar.' },
      { id: 'project', label: 'Project name', placeholder: 'vibeshare-data' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'API token', secret: true, hint: 'Account → Cloudflare Pages: Edit.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.project ?? '').trim()}.pages.dev`, values.folder ?? ''),
    // Skeleton: the push pipeline uploads each content id with the Pages direct upload API
    // (POST /accounts/<account>/pages/projects/<project>/deployments).
  },
  {
    id: 'gitlab',
    name: 'GitLab Pages',
    signup: 'https://gitlab.com/users/sign_up',
    docs: 'https://docs.gitlab.com/ee/user/project/pages/',
    about: 'Free project sites at <namespace>.gitlab.io/<project>/.',
    steps: [
      'Open a free GitLab account and create a public project.',
      'Add a .gitlab-ci.yml with a pages job (artifact path: public/) and push it — the pipeline publishes the site.',
      'The site appears at https://<namespace>.gitlab.io/<project>/ (a project named <namespace>.gitlab.io publishes at the root).',
      'Create an access token: Settings → Access tokens → scope api (or write_repository) and fill in the fields below.',
    ],
    fields: [
      { id: 'namespace', label: 'User or group', placeholder: 'yourname' },
      { id: 'project', label: 'Project', placeholder: 'vibeshare-data' },
      { id: 'branch', label: 'Branch', default: 'main' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'Access token', secret: true, hint: 'Scope api (or write_repository).' },
    ],
    buildBaseUrl: (values) => {
      const namespace = (values.namespace ?? '').trim();
      const project = (values.project ?? '').trim();
      const root = project.toLowerCase() === `${namespace.toLowerCase()}.gitlab.io`;
      return buildUrl(`${namespace}.gitlab.io`, ...(root ? [values.folder ?? ''] : [project, values.folder ?? '']));
    },
    // Skeleton: the push pipeline commits each content id through the GitLab repository
    // files API (PUT /api/v4/projects/<id>/repository/files/<path>).
  },
  {
    id: 'netlify',
    name: 'Netlify',
    signup: 'https://app.netlify.com/signup',
    docs: 'https://docs.netlify.com/get-started/overview/',
    about: 'Free drag-and-drop sites on a <site>.netlify.app address.',
    steps: [
      'Open a free Netlify account and add a new site: “Deploy manually” and drag in any folder (an index.html is enough).',
      'Rename the site to get https://<site>.netlify.app — that is your base URL.',
      'Create a personal access token: User settings → Applications → New access token.',
      'Fill in the fields below; pushes upload a new deploy of the folder.',
    ],
    fields: [
      { id: 'site', label: 'Site name', placeholder: 'vibeshare-data' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'Personal access token', secret: true },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.site ?? '').trim()}.netlify.app`, values.folder ?? ''),
    // Skeleton: the push pipeline posts a zip deploy to the Netlify API
    // (POST /api/v1/sites/<site-id>/deploys).
  },
  {
    id: 'vercel',
    name: 'Vercel',
    signup: 'https://vercel.com/signup',
    docs: 'https://vercel.com/docs/deployments/quickstart',
    about: 'Free static deployments on a <project>.vercel.app address.',
    steps: [
      'Open a free Vercel account and add a project (import a git repository or deploy a folder from the CLI).',
      'The site appears at https://<project>.vercel.app/.',
      'Create a token: Account Settings → Tokens.',
      'Fill in the fields below; pushes create a new deployment of the folder.',
    ],
    fields: [
      { id: 'project', label: 'Project name', placeholder: 'vibeshare-data' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'Token', secret: true },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.project ?? '').trim()}.vercel.app`, values.folder ?? ''),
    // Skeleton: the push pipeline posts file uploads to the Vercel deployment API
    // (POST /v13/deployments).
  },
  {
    id: 'firebase',
    name: 'Firebase Hosting',
    signup: 'https://console.firebase.google.com/',
    docs: 'https://firebase.google.com/docs/hosting',
    about: 'Free hosting on a <projectId>.web.app address.',
    steps: [
      'Open a free Firebase account, add a project and enable Hosting (Build → Hosting → Get started).',
      'The site appears at https://<projectId>.web.app/.',
      'Install the Firebase CLI and run `firebase login:ci` for a CI token (or create a service account).',
      'Fill in the fields below; pushes upload the folder as a new Hosting release.',
    ],
    fields: [
      { id: 'projectId', label: 'Project id', placeholder: 'vibeshare-data' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'CI token', secret: true, hint: 'From `firebase login:ci`.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.projectId ?? '').trim()}.web.app`, values.folder ?? ''),
    // Skeleton: the push pipeline calls the Firebase Hosting REST API (serves files via
    // the Hosting version API and then releases that version).
  },
  {
    id: 'render',
    name: 'Render Static Sites',
    signup: 'https://render.com/register',
    docs: 'https://render.com/docs/static-sites',
    about: 'Free static sites on a <service>.onrender.com address.',
    steps: [
      'Open a free Render account and create a Static Site (New → Static Site), from a repository or a single-folder upload.',
      'The site appears at https://<service>.onrender.com/.',
      'Create an API key: Account Settings → API Keys (or use the service deploy hook).',
      'Fill in the fields below; pushes trigger a new deploy of the folder.',
    ],
    fields: [
      { id: 'service', label: 'Service name', placeholder: 'vibeshare-data' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'API key', secret: true },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.service ?? '').trim()}.onrender.com`, values.folder ?? ''),
    // Skeleton: the push pipeline triggers the service's deploy hook (or the Render API
    // publish of a content bundle).
  },
  {
    id: 'appwrite',
    name: 'Appwrite Sites',
    signup: 'https://cloud.appwrite.io/',
    docs: 'https://appwrite.io/docs/products/sites/',
    about: 'Free static sites on Appwrite Cloud, served under an appwrite.global (or custom) domain.',
    steps: [
      'Open a free Appwrite Cloud account, create a project and add a Site (Build → Sites → Create site).',
      'Upload the first build in the console; note the URL the site is served at.',
      'Create an API key: project → Settings → API keys with sites.write.',
      'Fill in the fields below and set the base URL to the URL the console shows.',
    ],
    fields: [
      { id: 'endpoint', label: 'API endpoint', default: 'https://cloud.appwrite.io/v1' },
      { id: 'projectId', label: 'Project id', placeholder: '66f…' },
      { id: 'siteId', label: 'Site id', placeholder: '670…' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'API key', secret: true },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.siteId ?? '').trim()}.appwrite.global`, values.folder ?? ''),
    // Skeleton: the push pipeline creates a build through the Appwrite Sites API and
    // marks it ready (POST /projects/<project>/sites/<site>/builds).
  },
  {
    id: 'surge',
    name: 'Surge',
    signup: 'https://surge.sh/',
    docs: 'https://surge.sh/help/getting-started-with-surge',
    about: 'Free static hosting on any <name>.surge.sh domain, published from the command line.',
    steps: [
      'Install Node.js, then `npm install --global surge`.',
      'Run `surge` in any folder with an index.html, log in and pick a name: the site appears at https://<name>.surge.sh/.',
      'Run `surge token` and copy the token.',
      'Fill in the fields below; pushes run a publish of the folder to the domain.',
    ],
    fields: [
      { id: 'domain', label: 'Domain', placeholder: 'vibeshare-data.surge.sh' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'Surge token', secret: true, hint: 'From `surge token`.' },
    ],
    buildBaseUrl: (values) => buildUrl((values.domain ?? '').trim().replace(/^https?:\/\//, ''), values.folder ?? ''),
    // Skeleton: surge publishes from the CLI (or its minimal API) — the pipeline runs the
    // same publish the `surge` command does with SURGE_LOGIN and SURGE_TOKEN.
  },
  {
    id: 'neocities',
    name: 'Neocities',
    signup: 'https://neocities.org/',
    docs: 'https://neocities.org/docs/api',
    about: 'Free static sites at <site>.neocities.org with a simple upload API.',
    steps: [
      'Open a free Neocities account and create a site (the site name becomes https://<site>.neocities.org/).',
      'Upload a first file in the editor so the site goes live.',
      'In Settings → API Key create a key.',
      'Fill in the fields below; pushes upload each content id through the API.',
    ],
    fields: [
      { id: 'site', label: 'Site name', placeholder: 'vibeshare-data' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'apiKey', label: 'API key', secret: true },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.site ?? '').trim()}.neocities.org`, values.folder ?? ''),
    // Skeleton: the push pipeline posts the file to the Neocities upload API
    // (POST /api/upload with the API key as the bearer token).
  },
  {
    id: 'codeberg',
    name: 'Codeberg Pages',
    signup: 'https://codeberg.org/user/sign_up',
    docs: 'https://codeberg.org/pages',
    about: 'Free static sites from a Codeberg repository at <user>.codeberg.page.',
    steps: [
      'Open a free Codeberg account and create a public repository named “pages”.',
      'Push the site files to the default branch (see the Pages docs for the exact branch and configuration).',
      'The site appears at https://<user>.codeberg.page/ — check the URL the repository shows and adjust the base URL below if it differs.',
      'Create an access token: Settings → Applications → Generate token with repository write.',
      'Fill in the fields below; pushes commit each content id into the repository.',
    ],
    fields: [
      { id: 'user', label: 'User', placeholder: 'yourname' },
      { id: 'repo', label: 'Repository', default: 'pages' },
      { id: 'branch', label: 'Branch', default: 'main' },
      { id: 'folder', label: 'Folder for content ids', default: 'baseUrl' },
      { id: 'token', label: 'Access token', secret: true },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.user ?? '').trim()}.codeberg.page`, values.folder ?? ''),
    // Skeleton: Codeberg runs Forgejo — the push pipeline commits through its contents
    // API (POST /api/v1/repos/<user>/<repo>/contents/<path>), the same call as GitHub's.
  },
];

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

// ---------------------------------------------------------------------- pushing job data

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
 * Pushes one content id's bytes to a saved host. Only GitHub Pages is wired up; the rest
 * are skeletons that say which call their pipeline makes once it is connected.
 */
export async function pushHostedContent(host: HostConfig, cid: string, data: Uint8Array): Promise<PushResult> {
  switch (host.platform) {
    case 'github':
      return pushGitHub(host, cid, data);
    default: {
      const platform = hostingPlatform(host.platform);
      return {
        ok: false,
        message: `Skeleton: the ${platform.name} push pipeline is not connected yet. The base URL and the content id path work now — see the platform tab for the call it will make.`,
      };
    }
  }
}
const join = (...parts: string[]): string => parts.map((part) => part.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');