// The vercel platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, hostFolderParser } from '../url';
import { STARTER_HTML } from './shared';

export const vercel: HostingPlatform = {
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
    parseBaseUrl: hostFolderParser('project', '.vercel.app'),
    describeUrlShape: 'https://<project>.vercel.app/[<folder>/]',
    // Wired up: the push pipeline creates a deployment with the REST API
    // (POST https://api.vercel.com/v13/deployments), reusing the copies Vercel already holds.
    publish: 'vercel',
};
