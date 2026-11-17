// The gcloud platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { STARTER_HTML } from './shared';

export const gcloud: HostingPlatform = {
    id: 'gcloud',
    name: 'Google Cloud',
    signup: 'https://console.cloud.google.com/',
    docs: 'https://cloud.google.com/storage/docs/hosting-static-website',
    about: 'A Cloud Storage bucket served as a website at https://storage.googleapis.com/<bucket>/ — 5 GB free a month. Google asks for a card on the free trial.',
    steps: [
      {
        title: 'Create the free account and a project',
        lines: [
          'Open the link below: “Get started for free”, sign in with Google, fill in the short form (a card is required, the trial starts with credit).',
          'In the console, click the project selector (top left) → “New project”.',
          'Project name: paste the value below → “Create”.',
        ],
        copies: [{ label: 'Project name', value: 'vibeshare-data' }],
        links: [{ label: 'Start free on Google Cloud', url: 'https://console.cloud.google.com/' }],
        check: 'The project selector at the top shows your new project as the current one.',
      },
      {
        title: 'Create the bucket',
        lines: [
          'Open “Cloud Storage” → “Buckets” → “Create bucket”.',
          'Name: paste the value below (globally unique) → “Continue”.',
          'Location type: “Region” (pick one near you) → “Continue”.',
          'Storage class: “Standard” → Continue. Access control: “Uniform” → “Continue”. Everything else as it is → “Create”.',
        ],
        copies: [{ label: 'Bucket name (make it unique)', value: 'vibeshare-data-yourname' }],
        check: 'The bucket page opens and shows its “Objects” tab.',
      },
      {
        title: 'Upload a first page',
        lines: ['In the bucket click “Upload files”.', 'Pick the starter page you downloaded below → “Upload”.'],
        copies: [{ label: 'File name (must match exactly)', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'The Objects list shows index.html.',
      },
      {
        title: 'Let the public read the files',
        lines: [
          'Open the “Permissions” tab → “Public access prevention”: set it to “Inherited” if it says “Enforced”.',
          'Click “Grant access”. New principals: type allUsers. Role: search and pick “Storage Object Viewer”.',
          'Click “Save”, then “Allow” if it warns about public access.',
        ],
        copies: [
          { label: 'Principal', value: 'allUsers' },
          { label: 'Role', value: 'Storage Object Viewer' },
        ],
        check: 'The permissions list has a row: allUsers · Storage Object Viewer.',
      },
      {
        title: 'Turn the bucket into a website',
        lines: [
          'Open the “Settings” tab → “Static website” → “Edit”.',
          'Index page: index.html. Error page (optional): 404.html → “Save”.',
        ],
        copies: [{ label: 'Index page', value: 'index.html' }],
        check: 'Static website shows “On” and a “Website endpoint”.',
      },
      {
        title: 'Copy your base URL',
        lines: ['Copy the website endpoint shown under Settings → Static website (it ends with a slash).'],
        copies: [{ label: 'Site address (replace BUCKET)', value: 'https://storage.googleapis.com/BUCKET/' }],
        check: 'That address opens your index.html in a new tab.',
      },
    ],
    fields: [
      { id: 'bucket', label: 'Bucket name', placeholder: 'vibeshare-data-yourname' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'accessKey', label: 'HMAC access key id', secret: true, hint: 'Settings → Interoperability → “Create HMAC key” (service account key for storage).' },
      { id: 'secret', label: 'HMAC secret', secret: true, hint: 'Shown once, with the access key id.' },
    ],
    buildBaseUrl: (values) => {
      const bucket = (values.bucket ?? '').trim();
      const folder = (values.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
      if (!bucket) return '';
      return `https://storage.googleapis.com/${bucket}/${folder ? `${folder}/` : ''}`;
    },
    // Wired up: the push pipeline uploads each content id with the JSON API
    // (POST https://storage.googleapis.com/upload/storage/v1/b/<bucket>/o).
    publish: 'gcloud',
};
