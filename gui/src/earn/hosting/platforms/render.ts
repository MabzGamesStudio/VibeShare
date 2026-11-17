// The render platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, hostFolderParser } from '../url';

export const render: HostingPlatform = {
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
    parseBaseUrl: hostFolderParser('service', '.onrender.com'),
    // Wired up: the push pipeline commits to the repository with the GitHub contents API,
    // which makes Render rebuild (and a deploy is asked for besides).
    publish: 'render',
};
