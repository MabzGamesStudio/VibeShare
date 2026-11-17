// The azure platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { STARTER_HTML } from './shared';

export const azure: HostingPlatform = {
    id: 'azure',
    name: 'Azure',
    signup: 'https://azure.microsoft.com/free/',
    docs: 'https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-static-website',
    about: 'Azure Blob Storage serves a container as a website at https://<account>.…web.core.windows.net/ — 5 GB free a year. Azure asks for a card at signup.',
    steps: [
      {
        title: 'Create the free account',
        lines: [
          'Open the link below: “Start free”, sign in with a Microsoft account and fill in the short form (a card is required, you stay within the free offer).',
          'Skip the optional surveys until you reach the Azure portal.',
        ],
        links: [{ label: 'Start free on Azure', url: 'https://azure.microsoft.com/free/' }],
        check: 'portal.azure.com shows the Azure portal with “Create a resource” at the top left.',
      },
      {
        title: 'Create the storage account',
        lines: [
          '“Create a resource” → search “Storage account” → “Create”.',
          'Subscription: Free trial. Resource group: “Create new”, name it vibeshare-data → OK.',
          'Storage account name: paste the value below (lowercase, globally unique, 3–24 characters).',
          'Performance: Standard. Redundancy: LRS. → “Review + create” → “Create”.',
        ],
        copies: [{ label: 'Storage account name', value: 'vibesharedata' }],
        check: 'The deployment says “Your deployment is complete” and you can click “Go to resource”.',
      },
      {
        title: 'Turn on the static website',
        lines: [
          'In the storage account open “Settings” → “Static website” → “Enabled”.',
          'Index document name: index.html → “Save”.',
          'Copy the “Primary endpoint” that appears — it ends with a slash.',
        ],
        copies: [{ label: 'Primary endpoint (example — use yours)', value: 'https://vibesharedata.z13.web.core.windows.net/' }],
        check: 'A primary endpoint address is shown under the enable switch.',
      },
      {
        title: 'Upload a first page',
        lines: [
          'Open “Data storage” → “Containers” → the container named $web (it was just created).',
          '“Upload” → “Browse for files” → pick the starter page you downloaded below → “Upload”.',
        ],
        copies: [{ label: 'File name (must match exactly)', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'The $web container lists index.html.',
      },
      {
        title: 'See your site',
        lines: ['Open the primary endpoint from step 3 in a new tab.'],
        check: 'That address opens your index.html.',
      },
      {
        title: 'Create the access the client pushes with',
        lines: [
          'In the storage account open “Settings” → “Access keys”.',
          'Show key1 and copy its “Key” value (or the connection string).',
        ],
        check: 'You have copied a 52-character key for the next step.',
      },
    ],
    fields: [
      { id: 'endpoint', label: 'Primary endpoint', placeholder: 'https://vibesharedata.z13.web.core.windows.net/', hint: 'Static website → Primary endpoint (with its trailing slash).' },
      { id: 'account', label: 'Storage account name', placeholder: 'vibesharedata' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'key', label: 'Access key', secret: true, hint: 'Settings → Access keys → key1.' },
    ],
    buildBaseUrl: (values) => {
      const endpoint = (values.endpoint ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const account = (values.account ?? '').trim();
      const host = endpoint || (account ? `${account}.z13.web.core.windows.net` : '');
      const folder = (values.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
      return host ? `https://${host}/${folder ? `${folder}/` : ''}` : '';
    },
    // Wired up: the push pipeline puts each content id into the $web container
    // (PUT https://<account>.blob.core.windows.net/$web/<path> with the access key).
    publish: 'azure',
};
