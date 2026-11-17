// The netlify platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, hostFolderParser } from '../url';
import { STARTER_HTML } from './shared';

export const netlify: HostingPlatform = {
    id: 'netlify',
    name: 'Netlify',
    signup: 'https://app.netlify.com/signup',
    docs: 'https://docs.netlify.com/get-started/',
    about: 'Drag a folder onto Netlify Drop and it is online at <name>.netlify.app in seconds. No credit card.',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below (an email address, or continue with GitHub).'],
        links: [{ label: 'Sign up for Netlify', url: 'https://app.netlify.com/signup' }],
        check: 'You are in the Netlify dashboard and see “Add new site”.',
      },
      {
        title: 'Deploy a first folder',
        lines: [
          '“Add new site” → “Deploy manually”.',
          'Download the folder below (a zip with VibeShare/index.html), unzip it, and drag the VibeShare folder onto the big drop area.',
          'Wait for “Site is live”.',
        ],
        download: {
          label: 'Download the VibeShare folder (zip)',
          zip: 'VibeShare.zip',
          entries: [{ path: 'VibeShare/index.html', text: STARTER_HTML }],
        },
        check: 'The Deploys page lists a deployment and shows a *.netlify.app address.',
      },
      {
        title: 'Name your project',
        lines: [
          'Type the project name below — the site is served at <name>.netlify.app.',
          'The name is kept for the next step (Access details) automatically.',
        ],
        fields: ['site'],
        check: 'The Project name field below is filled in.',
      },
      {
        title: 'See your site',
        lines: ['Open the address below in a new tab — it is the project name you typed in step 3, as <name>.netlify.app.'],
        copies: [{ label: 'Site address', value: 'https://<site>.netlify.app/' }],
        check: 'That address opens your page.',
      },
      {
        title: 'Create the access token the client pushes with',
        lines: [
          'Click your avatar in the left panel at the bottom left → “User settings” → “Applications”.',
          'Under “Personal access tokens” click “New access token”, name it vibeshare, and set the expiration date for this token to whatever timespan you would like, then “Generate”.',
          'Copy it now (it starts with nfp_) — Netlify shows it only once.',
          'Paste it into the field below — it is kept for the next step (Access details) automatically.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field below is filled with an nfp_ token.',
      },
      {
        title: 'Make the site public',
        lines: ['In project configuration → Project details → Visitor access, set the “Visibility” to public and Save.'],
        check: 'Visitor access shows Visibility: public.',
      },
    ],
    fields: [
      { id: 'site', label: 'Project name', placeholder: 'vibeshare-data', hint: 'The site is served at <name>.netlify.app — Site configuration → Change site name.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'token', label: 'Access token', secret: true, hint: 'User settings → Applications → personal access token.' },
    ],
    buildBaseUrl: (values) => buildUrl(`${(values.site ?? '').trim()}.netlify.app`, values.folder ?? ''),
    buildSiteUrl: (values) => buildUrl(`${(values.site ?? '').trim()}.netlify.app`),
    parseBaseUrl: hostFolderParser('site', '.netlify.app'),
    describeUrlShape: 'https://<site>.netlify.app/[<folder>/]',
    // Wired up: the push creates a deployment with the files API
    // (POST https://api.netlify.com/api/v1/sites/<site>/deploys), carrying everything the
    // site already serves plus the content id, and the deploy goes live by itself.
    publish: 'netlify',
};
