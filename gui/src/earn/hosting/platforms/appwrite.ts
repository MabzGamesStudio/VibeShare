// The appwrite platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { STARTER_HTML } from './shared';

export const appwrite: HostingPlatform = {
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
};
