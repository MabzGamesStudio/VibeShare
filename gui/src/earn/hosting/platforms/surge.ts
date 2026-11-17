// The surge platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl } from '../url';
import { STARTER_HTML } from './shared';

export const surge: HostingPlatform = {
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
};
