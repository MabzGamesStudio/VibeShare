// The wizard's steps after the account setup: where each platform's access details
// come from, how it serves <base>/<cid>, and what saving and offering it does.

import type { HostingStep, PlatformGuide } from './types';

/**
 * The three steps every platform shares after the account setup — each platform fills
 * them in with its own words about where the files land and how to see them.
 */
function urlGuide(lands: string, verify: string): HostingStep[] {
  return [
    {
      title: 'Read the base URL',
      lines: [
        'The field below was filled in from your answers; if the platform shows another address, type over it — it is editable.',
        lands,
      ],
      check: 'The Base URL field starts with http:// or https:// and ends with a slash.',
    },
    {
      title: 'Pick the content id to host',
      lines: [
        'Fetch the ids your providers are waiting for (below), or paste one by hand — it fills the Content id field.',
        verify,
      ],
      check: 'The Content id field holds an id and the example address under it shows that id at the end.',
    },
  ];
}

/** Saving the host, offering it to provider nodes, and putting the job's bytes on the site. */
function saveGuide(push: string): HostingStep[] {
  return [
    {
      title: 'Save this host and offer it to your providers',
      lines: [
        'Give it a name you recognise later (the tab label), then press the button below: it saves the host on this device and gives its base URL to your provider nodes in one go.',
        'Each provider now queries <base>/<cid> for any content id it is asked for, and pays credits when the bytes hash to the id.',
      ],
      check: 'A toast says “Saved …”, then “Offered … to N provider node(s)”.',
    },
    {
      title: 'Put the job’s bytes on the site',
      lines: [push],
      check: 'The bytes of that content id are served at <base>/<cid> — the provider can download and pay for them.',
    },
  ];
}

export const PLATFORM_GUIDES: Record<string, PlatformGuide> = {
  github: {
    access: [
      {
        title: 'Where the repository lives',
        lines: ['Open your repository in a browser: the address reads github.com/OWNER/REPO.', 'Owner and Repository are those two parts, typed exactly as shown.'],
        fields: ['owner', 'repo'],
        check: 'Owner and Repository match the address of your repository page.',
      },
      {
        title: 'Which branch Pages publishes',
        lines: ['Open Settings → Pages in the repository: the “Branch” line shows it (usually main, folder / (root)).'],
        fields: ['branch'],
        check: 'The Branch field holds the same name Settings → Pages shows.',
      },
      {
        title: 'Where content ids go',
        lines: ['The client commits every content id into this folder: <folder>/<cid>.', 'Leave it empty to put them at the repository root instead.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The access token',
        lines: [
          'Avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → “Generate new token”.',
          'Token name vibeshare · Repository access: “Only select repositories” → your repository · Repository permissions → Contents: Read and write.',
          'Copy it now (it starts with github_pat_) and paste it below — GitHub shows it only once.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field is filled (dots) with a github_pat_ token.',
      },
    ],
    url: urlGuide(
      'On GitHub Pages the folder is a real directory in your repository: the client commits <folder>/<cid> and Pages serves it about a minute later.',
      'Open the example address in a browser — before the first push it answers 404, after it shows the bytes.'
    ),
    save: saveGuide(
      'The GitHub push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and commits it with the token.'
    ),
  },
  cloudflare: {
    access: [
      {
        title: 'The account id',
        lines: ['Open Workers & Pages: the account id is the 32-character string in the page address (dash.cloudflare.com/<account-id>/workers) or in the sidebar.'],
        fields: ['account'],
        check: 'The Account id field holds 32 characters with no spaces.',
      },
      {
        title: 'The project name',
        lines: ['Workers & Pages → your project: its address is <project>.pages.dev.'],
        fields: ['project'],
        check: 'The Project name matches the address you opened in step 2.',
      },
      {
        title: 'Where content ids go',
        lines: ['The client uploads each content id as <folder>/<cid> in that project. Leave the folder empty to use the site root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The API token',
        lines: [
          'Profile icon → My Profile → API Tokens → “Create Token”.',
          'Name it vibeshare · Permissions: Account · Cloudflare Pages · Edit · Account Resources: your account → “Continue to summary” → “Create Token”.',
          'Copy the secret (it starts with cfut_) — Cloudflare shows it only once.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The API token field is filled with a cfut_ token.',
      },
    ],
    url: urlGuide(
      'Cloudflare Pages serves the project’s assets at <project>.pages.dev: each push becomes a deployment, and <folder>/<cid> is the path inside it.',
      'Open the example address — 404 until the first deployment, the bytes after it.'
    ),
    save: saveGuide(
      'The Cloudflare push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and uploads it with the direct upload API (POST /accounts/<account>/pages/projects/<project>/deployments).'
    ),
  },
  gitlab: {
    access: [
      {
        title: 'Which branch the pipeline runs on',
        lines: ['Open Manage → Repository → Branches: the branch with the pages job is the one to use (new projects start on main).'],
        fields: ['branch'],
        check: 'The Branch field matches the branch your .gitlab-ci.yml was committed to.',
      },
      {
        title: 'Where content ids go',
        lines: [
          'The client commits each content id one level under the folder Pages publishes — with the folder below as public, the file lands at public/public/<cid> in the repository.',
          'Pages publishes the public folder as the site root, so the file is served at <folder>/<cid>: the base URL ends in the folder, and every content id is the base URL with the id appended after it.',
        ],
        fields: ['folder'],
        check: 'The folder field says where the content ids live — public by default — and it is the last part of the base URL.',
      },
      {
        title: 'The access token',
        lines: [
          'Avatar → Edit profile → Access → Personal access tokens → “Generate token” → Legacy token.',
          'Name it vibeshare · scopes: api (read-write, needed to commit files) and write_repository · “Generate token”.',
          'Copy it now — GitLab shows it only once, then only as a prefix.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field is filled with a glpat- token.',
      },
    ],
    url: urlGuide(
      'Both address shapes end in the content folder: content ids live at <folder>/<cid> in the site (public/<folder>/<cid> in the repository, one level under the folder Pages publishes). The base URL is built from the fields above — edit it if the platform shows a different address and it fills the fields back in. Take User or group and Project name from the project page only: the unique domain from Deploy → Pages is a site address, not a project name — never copy its first part into the Project name field.',
      'Open the example address — 404 until the commit below is pushed and the pipeline turns green. The address ends in the folder; the content id is appended after it.'
    ),
    save: saveGuide(
      'The GitLab push is wired end to end: press “Publish the job’s content id to this host & save” — it commits public/<folder>/<cid> with your token and Pages serves it at <base>/<cid> about a minute later.'
    ),
  },
  netlify: {
    access: [
      {
        title: 'The project name',
        lines: ['Open the site → Site configuration → “Change site name”: the address is <name>.netlify.app. The name you typed in the first tab is already here.'],
        fields: ['site'],
        check: 'The Project name field matches the address of your site.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each push becomes a deploy; <folder>/<cid> is the path inside the deployed folder. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The access token',
        lines: [
          'Click your avatar in the left panel at the bottom left → “User settings” → “Applications” → “Personal access tokens” → “Generate new token”.',
          'Name it vibeshare, set the expiration date for this token to whatever timespan you would like, then “Generate”.',
          'Copy it now (it starts with nfp_) — Netlify shows it only once. The token you pasted in the first tab is already here.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field is filled with an nfp_ token.',
      },
      {
        title: 'Set the site’s deploy settings',
        lines: [
          'Open Site configuration → Build & deploy → Build settings: clear the Build command (it must be empty) and leave the Publish directory empty or “/”. This site is pushed whole — a build would replace the files the push put there.',
          'On the same page → Post processing → Asset optimization: switch it off — it rewrites the files the push uploads.',
          'Do not connect a Git repository to this site. Deploys come from the push; a site that builds from a repository replaces what the push put there.',
          'After a push, wait until Deploys shows the deploy as “Published” before checking the content id path — it can take about a minute.',
        ],
        check: 'Build command is empty, asset optimization is off, and no Git repository is connected to the site.',
      },
    ],
    url: urlGuide(
      'Netlify serves the deployed folder at <site>.netlify.app: a push redeploys, and <folder>/<cid> is the path inside it.',
      'Open the example address — 404 until a deploy carries the file.'
    ),
    save: saveGuide(
      'The Netlify push is wired end to end: press “Publish the job’s content id to this host & save” — it deploys <folder>/<cid> with the files API (POST https://api.netlify.com/api/v1/sites/<site>/deploys), carrying over everything the site already serves so nothing is dropped, and the deploy publishes by itself. The starter folder (the download button in the first tab) is the manual alternative: drag it into the Deploys page once and pushes add to what it set up.'
    ),
  },
  vercel: {
    access: [
      {
        title: 'Where content ids go',
        lines: ['Each push deploys the folder; <folder>/<cid> is the path inside it. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'Create the access token the client pushes with',
        lines: [
          'Avatar → “Account Settings” → “Tokens” (or open the Tokens link below).',
          '“Create Token” → name it vibeshare → set a scope if asked → “Create”.',
          'Copy it now — it is shown only once.',
        ],
        links: [{ label: 'Tokens page', url: 'https://vercel.com/account/tokens' }],
        fields: ['token'],
        check: 'The Access token field is filled with a vcp_ token.',
      },
    ],
    url: urlGuide(
      'Vercel serves the deployed folder at <project>.vercel.app: each push is a new deployment, and <folder>/<cid> is the path inside it.',
      'Open the example address — 404 until a deployment carries the file.'
    ),
    save: saveGuide(
      'The Vercel push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and creates a deployment with the REST API (POST https://api.vercel.com/v13/deployments), reusing the copies Vercel already holds.'
    ),
  },
  firebase: {
    access: [
      {
        title: 'The project id',
        lines: ['Firebase console → your project → Project settings → General: “Project ID” is the id (letters, digits and dashes).'],
        fields: ['project'],
        check: 'The Project id field matches Project settings → General → Project ID.',
      },
      {
        title: 'Where content ids go',
        lines: ['The client adds <folder>/<cid> to a Hosting release, so the site serves it under the project address. Leave the folder empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The service account key',
        lines: [
          'Project settings (gear icon) → “Service accounts”.',
          '“Generate new private key” → “Generate key”: a JSON file downloads.',
          'Paste the whole file contents below (it is a secret — it can deploy for you).',
        ],
        copies: [{ label: 'Where to click', value: 'Project settings → Service accounts → Generate new private key' }],
        fields: ['key'],
        check: 'The Service account key field is filled with the JSON from that download.',
      },
    ],
    url: urlGuide(
      'Firebase Hosting serves a release at <project>.web.app: <folder>/<cid> is a file inside the release, published by “firebase deploy”.',
      'Open the example address — 404 until a deploy carries the file.'
    ),
    save: saveGuide(
      'The Firebase push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers, uploads it as a Hosting version and releases it (POST /v1beta1/sites/<site>/versions, then a release).'
    ),
  },
  render: {
    access: [
      {
        title: 'The site name',
        lines: ['Open the site → “Settings” → “Name”: the address is <name>.onrender.com.'],
        fields: ['service'],
        check: 'The Site name matches the address of your site.',
      },
      {
        title: 'The repository it builds',
        lines: ['The repository is owner/name as it appears in GitHub (e.g. yourname/vibeshare-data).'],
        fields: ['repo'],
        check: 'The Repository field holds owner/name of the connected repository.',
      },
      {
        title: 'The branch it builds',
        lines: ['The branch Render deploys is the one the repository pushes to (usually main).'],
        fields: ['branch'],
        check: 'The Branch field holds the branch your repository uses.',
      },
      {
        title: 'Where content ids go',
        lines: ['Render rebuilds the repository on every push; <folder>/<cid> is the path inside the publish directory. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The API key',
        lines: [
          'Avatar → “Account Settings” → “API Keys” → “Create API Key”.',
          'Name it vibeshare → “Create”. Copy it now — it is shown only once.',
        ],
        copies: [{ label: 'Key name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The API key field is filled.',
      },
      {
        title: 'The GitHub token the client commits with',
        lines: [
          'The client commits each content id into the repository and Render rebuilds — that needs a GitHub token with Contents: Read and write on that repository.',
          'The token you made in the GitHub tab works here (fine-grained, that repository, Contents: Read and write).',
        ],
        fields: ['ghToken'],
        check: 'The GitHub token field is filled (dots).',
      },
    ],
    url: urlGuide(
      'Render serves the publish directory at <service>.onrender.com: <folder>/<cid> is a file in that directory, published by the next build.',
      'Open the example address — 404 until a build carries the file.'
    ),
    save: saveGuide(
      'The Render push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and commits <folder>/<cid> to the repository (the same contents API as GitHub), which makes Render rebuild.'
    ),
  },
  appwrite: {
    access: [
      {
        title: 'The base URL',
        lines: [
          'Open the site → “Domains”: the built-in domain is listed there (it ends in appwrite.site).',
          'Copy it into the field with its trailing slash — this is the address the whole panel uses.',
        ],
        fields: ['endpoint'],
        check: 'The Base URL field holds the built-in domain from the Domains section.',
      },
      {
        title: 'The project id',
        lines: ['The console shows the project id directly under the project name (Settings → General too).'],
        fields: ['project'],
        check: 'The Project id field matches the id under the project name.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each push becomes a deployment of the site; <folder>/<cid> is the path inside it. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The API key',
        lines: [
          'Left sidebar → “Settings” → “API keys” → “Create API key”.',
          'Name it vibeshare · Scopes: sites.read and sites.write → “Create”.',
          'Copy the secret now — Appwrite shows it only once.',
        ],
        copies: [{ label: 'Key name', value: 'vibeshare' }],
        fields: ['key'],
        check: 'The API key field is filled with a secret that starts with standard_.',
      },
    ],
    url: urlGuide(
      'Appwrite Sites serves each deployment at the site’s built-in domain: <folder>/<cid> is the path inside the deployment.',
      'Open the example address — 404 until a deployment carries the file.'
    ),
    save: saveGuide(
      'The Appwrite push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and creates a deployment for the site (POST /sites/<siteId>/deployments).'
    ),
  },
  surge: {
    access: [
      {
        title: 'The domain you published',
        lines: ['The domain is what you typed when Surge asked for it (usually <name>.surge.sh), without https://.'],
        fields: ['domain'],
        check: 'The Domain field matches what “surge” printed when it finished.',
      },
      {
        title: 'Where content ids go',
        lines: ['Running surge inside a folder publishes its files; <folder>/<cid> is the path inside that folder.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The account it publishes as',
        lines: ['The email you gave on the first “surge” run is your account.'],
        fields: ['email'],
        check: 'The Account email is the address you signed up with.',
      },
      {
        title: 'The login token',
        lines: ['Run the command below in a terminal and copy what it prints.'],
        copies: [{ label: 'Command — print token', value: 'surge token' }],
        fields: ['token'],
        check: 'The Login token field is filled.',
      },
    ],
    url: urlGuide(
      'Surge serves the folder you publish at <domain>: <folder>/<cid> is a file inside it, published by the next “surge” run.',
      'Open the example address — 404 until you publish that file.'
    ),
    save: saveGuide(
      'The Surge push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and deploys the file with the Surge API (POST https://surge.surge.sh — domain, file, token).'
    ),
  },
  neocities: {
    access: [
      {
        title: 'The site name',
        lines: ['The site name is the part before .neocities.org in your site’s address.'],
        fields: ['site'],
        check: 'The Site name matches the address you opened in step 2.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each push uploads a file; <folder>/<cid> is the path inside your site. Leave it empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The API key',
        lines: ['Open “Settings” → “API Key”.', 'Click “Generate” and copy the key it prints — it authorises uploads for this site.'],
        fields: ['apiKey'],
        check: 'The API key field is filled.',
      },
    ],
    url: urlGuide(
      'Neocities serves the files you uploaded at <site>.neocities.org: <folder>/<cid> is a file path in your site.',
      'Open the example address — 404 until you upload that file.'
    ),
    save: saveGuide(
      'The Neocities push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and posts the file to the upload API (POST https://neocities.org/api/upload, bearer token).'
    ),
  },
  codeberg: {
    access: [
      {
        title: 'The user it is served under',
        lines: ['Your Codeberg name is the first part of the address: <user>.pages.codeberg.org.'],
        fields: ['user'],
        check: 'The User field is your Codeberg name.',
      },
      {
        title: 'The repository and branch',
        lines: ['The pages repository is pages.repo on the branch you pushed (usually main).'],
        fields: ['repo', 'branch'],
        check: 'Repository says pages.repo and the branch matches what you pushed.',
      },
      {
        title: 'Where content ids go',
        lines: ['The client commits <folder>/<cid> into pages.repo; Codeberg Pages serves it at that path. Leave the folder empty for the root.'],
        fields: ['folder'],
        check: 'The folder field says where the files will land.',
      },
      {
        title: 'The access token',
        lines: [
          'Avatar → “Settings” → “Applications”.',
          'Under “Personal access tokens” name it vibeshare, tick the repository write scope, “Generate”.',
          'Copy it now — Codeberg shows it only once.',
        ],
        copies: [{ label: 'Token name', value: 'vibeshare' }],
        fields: ['token'],
        check: 'The Access token field is filled.',
      },
    ],
    url: urlGuide(
      'Codeberg Pages serves pages.repo at <user>.pages.codeberg.org: <folder>/<cid> is a file in that repository.',
      'Open the example address — 404 until the next commit carries the file.'
    ),
    save: saveGuide(
      'The Codeberg push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and commits through the Forgejo contents API (POST /api/v1/repos/<user>/<repo>/contents/<path>), the same call GitHub uses.'
    ),
  },
  aws: {
    access: [
      {
        title: 'The bucket and its region',
        lines: ['Open the bucket → “Properties”: “AWS Region” is the region, the name is at the top.', 'Both must match exactly: the address is built from them.'],
        fields: ['bucket', 'region'],
        check: 'Bucket name and Region are the ones shown on the bucket’s Properties page.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each content id is an object key <folder>/<cid> in the bucket. Leave the folder empty to write at the top level.'],
        fields: ['folder'],
        check: 'The folder field says where the objects will land.',
      },
      {
        title: 'The access keys',
        lines: [
          'IAM console (console.aws.amazon.com/iam) → “Users” → “Create user” → name vibeshare → “Next”.',
          'Attach the policy “AmazonS3FullAccess” → “Create user”.',
          'Open the user → “Create access key” → “Command Line Interface” → “Next” → “Create access key”.',
          'Copy the access key id and the secret (the secret is shown only once) into the two fields.',
        ],
        copies: [{ label: 'Policy to attach', value: 'AmazonS3FullAccess' }],
        fields: ['accessKeyId', 'secretAccessKey'],
        check: 'Both key fields are filled — access key id starts with AKIA.',
      },
    ],
    url: urlGuide(
      'The S3 website endpoint serves objects by key: <folder>/<cid> is an object in the bucket. Note it is plain http:// — S3 websites have no HTTPS.',
      'Open the example address — before the first upload it answers 404 (or NoSuchKey), after it the bytes.'
    ),
    save: saveGuide(
      'The AWS push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and puts the object in the bucket (PUT /<folder>/<cid> against the endpoint, signed with the access keys).'
    ),
  },
  azure: {
    access: [
      {
        title: 'The primary endpoint',
        lines: [
          'In the storage account open “Settings” → “Static website”: the “Primary endpoint” is the address (it ends with a slash).',
          'Paste it below — it already names your account and region, so nothing else needs typing.',
        ],
        fields: ['endpoint'],
        check: 'The Primary endpoint field holds the address shown under the switch.',
      },
      {
        title: 'The storage account name',
        lines: ['The name is the first part of the endpoint (before .z…web.core.windows.net) and the name you chose when creating the account.'],
        fields: ['account'],
        check: 'The Storage account name matches the endpoint above it.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each content id is a blob in the $web container at <folder>/<cid>. Leave the folder empty for the container root.'],
        fields: ['folder'],
        check: 'The folder field says where the blobs will land.',
      },
      {
        title: 'The access key',
        lines: [
          'In the storage account: “Settings” → “Access keys”.',
          'Show key1 and copy its “Key” value (52 characters) into the field below.',
        ],
        copies: [{ label: 'Where to click', value: 'Settings → Access keys → key1 → Show' }],
        fields: ['key'],
        check: 'The Access key field is filled with a 52-character key.',
      },
    ],
    url: urlGuide(
      'Azure serves the $web container at the primary endpoint: <folder>/<cid> is a blob path in that container, visible as soon as it is uploaded.',
      'Open the example address — 404 until the blob is uploaded.'
    ),
    save: saveGuide(
      'The Azure push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and puts the blob in $web (PUT https://<account>.blob.core.windows.net/$web/<path> with the access key).'
    ),
  },
  gcloud: {
    access: [
      {
        title: 'The bucket',
        lines: ['Open the bucket: its name is at the top of the page (globally unique, no https://).'],
        fields: ['bucket'],
        check: 'The Bucket name matches the bucket you opened.',
      },
      {
        title: 'Where content ids go',
        lines: ['Each content id is an object <folder>/<cid> in the bucket. Leave the folder empty to write at the top level.'],
        fields: ['folder'],
        check: 'The folder field says where the objects will land.',
      },
      {
        title: 'The HMAC keys',
        lines: [
          'Cloud Storage → “Settings” → “Interoperability” → “HMAC keys for service accounts” → “Create HMAC key”.',
          'Pick a service account (or create one) → “Create”.',
          'Copy the HMAC access id and the secret — the secret is shown only once — into the two fields.',
        ],
        copies: [{ label: 'Where to click', value: 'Cloud Storage → Settings → Interoperability → Create HMAC key' }],
        fields: ['accessKey', 'secret'],
        check: 'Both key fields are filled (the access id is 20 characters).',
      },
    ],
    url: urlGuide(
      'The bucket’s website endpoint serves objects by key: <folder>/<cid> is an object in the bucket, readable by anyone because allUsers may view objects.',
      'Open the example address — 404 (or AccessDenied until the object is public) before the first upload, the bytes after it.'
    ),
    save: saveGuide(
      'The Google Cloud push is wired end to end: press “Publish the job’s content id to this host & save” — it downloads the id from your providers and uploads the object (POST https://storage.googleapis.com/upload/storage/v1/b/<bucket>/o, signed with the HMAC keys).'
    ),
  },
};

/** The guide behind the wizard’s last three steps; every platform has one. */
export function platformGuide(id: string): PlatformGuide {
  return PLATFORM_GUIDES[id] ?? PLATFORM_GUIDES.github;
}
