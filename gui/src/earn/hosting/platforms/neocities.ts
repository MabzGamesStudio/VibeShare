// The neocities platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, hostFolderParser } from '../url';
import { STARTER_HTML } from './shared';

export const neocities: HostingPlatform = {
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
    parseBaseUrl: hostFolderParser('site', '.neocities.org'),
    // Wired up: the push pipeline posts the file to the Neocities upload API
    // (POST /api/upload with the API key as the bearer token).
    publish: 'neocities',
};
