// The github platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, splitUrl } from '../url';
import { STARTER_HTML } from './shared';

export const github: HostingPlatform = {
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
    // https://<owner>.github.io/<repo>/[<folder>/] — except the user site (a repository
    // named <owner>.github.io), which Pages serves at the domain root instead.
    parseBaseUrl: (url, values): Record<string, string> | null => {
      const split = splitUrl(url);
      if (!split) return null;
      const tail = '.github.io';
      if (!split.host.endsWith(tail)) return null;
      const owner = split.host.slice(0, -tail.length);
      if (!owner) return null;
      const userSite = `${owner}.github.io`;
      const [repo, ...folder] = split.path;
      if (!repo) return { owner, repo: userSite, folder: '' };
      if (repo.toLowerCase() === userSite.toLowerCase()) return { owner, repo: userSite, folder: folder.join('/') };
      if ((values.repo ?? '').trim().toLowerCase() === userSite.toLowerCase()) return { owner, folder: split.path.join('/') };
      return { owner, repo, folder: folder.join('/') };
    },
    describeUrlShape: 'https://<owner>.github.io/<repository>/[<folder>/] (the user site https://<owner>.github.io/ when the repository is <owner>.github.io)',
    publish: 'github',
};
