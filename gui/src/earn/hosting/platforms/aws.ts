// The aws platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { STARTER_HTML } from './shared';

export const aws: HostingPlatform = {
    id: 'aws',
    name: 'AWS',
    signup: 'https://portal.aws.amazon.com/billing/signup',
    docs: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/HostingWebsiteOnS3Setup.html',
    about: 'Amazon S3 hosts a bucket as a website at http://<bucket>.s3-website-<region>.amazonaws.com/ — 5 GB and 20 000 requests a month free. AWS asks for a card at signup.',
    steps: [
      {
        title: 'Create the AWS account',
        lines: [
          'Open the signup link below: email, password, account name.',
          'AWS asks for a payment method even for the free tier — you are charged only past the free limits.',
          'Finish the phone verification, then sign in to the console.',
        ],
        links: [{ label: 'Create an AWS account', url: 'https://portal.aws.amazon.com/billing/signup' }],
        check: 'console.aws.amazon.com shows the Console Home with a search bar at the top.',
      },
      {
        title: 'Create the bucket',
        lines: [
          'Search the console for “S3” and open it → “Create bucket”.',
          'Bucket name: paste the value below (it must be unique across all of AWS). Region: pick one near you.',
          'Scroll to “Block Public Access settings”: untick “Block all public access” and tick the acknowledgement.',
          'Leave the rest as it is → “Create bucket”.',
        ],
        copies: [{ label: 'Bucket name (make it unique)', value: 'vibeshare-data-yourname' }],
        check: 'The bucket is listed under “General purpose buckets”.',
      },
      {
        title: 'Upload a first page',
        lines: [
          'Open the bucket → “Upload” → “Add files” → pick the starter page you downloaded below.',
          'Click “Upload”, wait for “Upload succeeded”, then “Close”.',
        ],
        copies: [{ label: 'File name (must match exactly)', value: 'index.html' }],
        download: { label: 'Download the starter page', zip: 'index.html', entries: [{ path: 'index.html', text: STARTER_HTML }] },
        check: 'The Objects list shows index.html with its size.',
      },
      {
        title: 'Turn the bucket into a website',
        lines: [
          'Open the “Properties” tab → scroll to “Static website hosting” → “Edit”.',
          'Choose “Use this bucket to host a website”.',
          'Index document: index.html. Error document: 404.html. → “Save changes”.',
        ],
        check: 'Static website hosting says “Enabled” and shows an endpoint address.',
      },
      {
        title: 'Let the public read the files',
        lines: [
          'Open the “Permissions” tab → “Bucket policy” → “Edit”.',
          'Paste the whole line below, replace BUCKET with your bucket name, then “Save changes”.',
        ],
        copies: [
          {
            label: 'Bucket policy (replace BUCKET)',
            value: '{"Version":"2012-10-17","Statement":[{"Sid":"PublicRead","Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::BUCKET/*"}]}',
          },
        ],
        check: 'The saved bucket policy shows the PublicRead statement.',
      },
      {
        title: 'Copy your base URL',
        lines: [
          '“Properties” → bottom of the page → “Static website hosting” → copy the “Bucket website endpoint”.',
          'It starts with http:// (S3 websites have no HTTPS) and ends with a slash — that is your base URL.',
        ],
        copies: [{ label: 'Site address (replace the two parts)', value: 'http://BUCKET.s3-website-REGION.amazonaws.com/' }],
        check: 'That address opens your index.html in a new tab.',
      },
    ],
    fields: [
      { id: 'bucket', label: 'Bucket name', placeholder: 'vibeshare-data-yourname' },
      { id: 'region', label: 'Region', placeholder: 'eu-west-1', hint: 'The region you chose when creating the bucket.' },
      { id: 'folder', label: 'Folder for content ids', default: 'public' },
      { id: 'accessKeyId', label: 'Access key id', placeholder: 'AKIA…', secret: true, hint: 'IAM → Users → Security credentials → Create access key.' },
      { id: 'secretAccessKey', label: 'Secret access key', secret: true, hint: 'Shown once, together with the access key id.' },
    ],
    buildBaseUrl: (values) => {
      const bucket = (values.bucket ?? '').trim();
      const region = (values.region ?? '').trim();
      const folder = (values.folder ?? '').trim().replace(/^\/+|\/+$/g, '');
      if (!bucket || !region) return '';
      return `http://${bucket}.s3-website-${region}.amazonaws.com/${folder ? `${folder}/` : ''}`;
    },
    // Wired up: the push pipeline puts each content id into the bucket (S3 Upload, or a
    // signed PUT against the endpoint with the access keys).
    publish: 'aws',
};
