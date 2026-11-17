// The codeberg platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, hostFolderParser } from '../url';
import { STARTER_HTML } from './shared';

export const codeberg: HostingPlatform = {
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
    parseBaseUrl: hostFolderParser('user', '.pages.codeberg.org'),
    // Wired up: Codeberg runs Forgejo — the push pipeline commits through its contents
    // API (POST /api/v1/repos/<user>/<repo>/contents/<path>), the same call as GitHub's.
    publish: 'codeberg',
};
