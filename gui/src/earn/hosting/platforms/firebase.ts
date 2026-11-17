// The firebase platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, hostFolderParser } from '../url';
import { STARTER_HTML } from './shared';

export const firebase: HostingPlatform = {
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
    parseBaseUrl: hostFolderParser('project', '.web.app'),
    // Wired up: the push pipeline deploys with the Hosting REST API
    // (sites/<site>/versions + release).
    publish: 'firebase',
};
