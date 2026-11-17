// The cloudflare platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, hostFolderParser } from '../url';
import { STARTER_HTML } from './shared';

export const cloudflare: HostingPlatform = {
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
    parseBaseUrl: hostFolderParser('project', '.pages.dev'),
    describeUrlShape: 'https://<project>.pages.dev/[<folder>/]',
    // Wired up: the push pipeline uploads each content id with the Pages direct upload API
    // (POST /accounts/<account>/pages/projects/<project>/deployments).
    publish: 'cloudflare',
};
