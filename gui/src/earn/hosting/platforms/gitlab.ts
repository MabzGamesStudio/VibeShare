// The gitlab platform definition for the provider-jobs wizard: account steps, the fields
// its base URL is built from, and the address shapes it is served under.

import type { HostingPlatform } from '../types';
import { buildUrl, splitUrl } from '../url';
import { STARTER_HTML } from './shared';

/**
 * The GitLab base URL from the fields. Both shapes end in the folder: content ids live at
 * <folder>/<cid> inside the published site (the repository holds them at
 * public/<folder>/<cid>, one level under the folder Pages publishes as the site root), so
 * <base>/<cid> always carries the folder and hash-verifies. The unique type trades the
 * long project path for the unique domain https://<project>-<six-digit-id>.gitlab.io/
 * — the same site, without the classic address's cross-origin redirect to it
 * (docs.gitlab.com/user/project/pages/getting_started_part_one/).
 */
function gitlabBaseUrl(values: Record<string, string>): string {
  const namespace = (values.namespace ?? '').trim();
  const project = (values.project ?? '').trim();
  const folder = (values.folder ?? '').trim();
  const uniqueId = (values.uniqueId ?? '').trim();
  if (!namespace || !project) return '';
  if ((values.urlType ?? 'project') === 'unique') {
    return uniqueId ? buildUrl(`${project}-${uniqueId}.gitlab.io`, folder) : '';
  }
  // A project named <namespace>.gitlab.io is the user/group site, served at the domain
  // root instead of under /<project>/ (same docs page).
  if (project.toLowerCase() === `${namespace}.gitlab.io`.toLowerCase()) return buildUrl(`${namespace}.gitlab.io`, folder);
  return buildUrl(`${namespace}.gitlab.io`, project, folder);
}

/**
 * Parses either GitLab address shape back into the fields. The unique domain
 * https://<project>-<six-digit-id>.gitlab.io/<folder>/ carries the flattened project name
 * and the six-character id in its host and never the namespace; the project site
 * https://<namespace>.gitlab.io/<project-path>/[<folder>/] carries the namespace in the
 * host and the rest in the path. `values` disambiguates what the address alone cannot
 * (a namespace that happens to end in a dash and six characters).
 */
function parseGitlabUrl(url: string, values: Record<string, string>): Record<string, string> | null {
  const split = splitUrl(url);
  if (!split) return null;
  const tail = '.gitlab.io';
  if (!split.host.endsWith(tail)) return null;
  const host = split.host.slice(0, -tail.length);
  if (!host) return null;
  const project = (values.project ?? '').trim().replace(/^\/+|\/+$/g, '');
  const folder = (values.folder ?? '').trim();
  // (b) The unique domain: <flattened project>-<six-character id>. The current project
  // pins where its name ends and the id begins when the host starts with it.
  const flatProject = project.replace(/[^0-9a-z]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const pinned = flatProject && host.toLowerCase().startsWith(`${flatProject}-`) ? host.slice(flatProject.length + 1) : '';
  const loose = /^(.+)-([0-9a-z]{6})$/i.exec(host);
  const id = /^[0-9a-z]{6}$/i.test(pinned) ? pinned : (loose?.[2] ?? '');
  if (id && (values.namespace ?? '').trim().toLowerCase() !== host.toLowerCase()) {
    return {
      urlType: 'unique',
      uniqueId: id.toLowerCase(),
      ...(pinned ? {} : { project: loose?.[1] ?? '' }),
      ...(split.path.length ? { folder: split.path.join('/') } : {}),
    };
  }
  // (a) The project site: the host is the namespace, the path the project (the full path
  // — subgroups included) and optionally the one folder part after it.
  const namespace = host;
  const path = split.path;
  if (!path.length) {
    // An empty path is a user/group site (a project named <namespace>.gitlab.io) or a
    // unique domain — the host is the namespace either way, but the project is not in
    // the address, so it is left alone.
    return { namespace, urlType: 'project' };
  }
  const joined = path.join('/');
  if (project && project.toLowerCase() === `${namespace}.gitlab.io`.toLowerCase()) {
    // The user/group site: its address root is the domain root, so the whole path is the
    // folder.
    return { namespace, urlType: 'project', folder: joined };
  }
  if (project && joined.toLowerCase() === project.toLowerCase()) return { namespace, urlType: 'project' };
  if (project && joined.toLowerCase().startsWith(`${project.toLowerCase()}/`)) {
    return { namespace, urlType: 'project', folder: joined.slice(project.length + 1) };
  }
  // A trailing part equal to the current folder is that folder (…/<project>/<folder>/).
  if (folder && path.length > 1 && path[path.length - 1].toLowerCase() === folder.toLowerCase()) {
    return { namespace, urlType: 'project', project: path.slice(0, -1).join('/') };
  }
  // Without the project field to anchor the split, the shape the address promises is
  // <project>/<folder>: one project part and the rest is the folder. A subgroup project
  // (several parts before the folder) is only readable once the project field holds its
  // path and the anchor above matches.
  if (path.length > 1) return { namespace, urlType: 'project', project: path[0], folder: path.slice(1).join('/') };
  return { namespace, urlType: 'project', project: joined };
}

export const gitlab: HostingPlatform = {
    id: 'gitlab',
    name: 'GitLab Pages',
    signup: 'https://gitlab.com/users/sign_up',
    docs: 'https://docs.gitlab.com/user/project/pages/',
    steps: [
      {
        title: 'Open the free account',
        lines: ['Sign up at the link below and confirm the email.', 'Sign in to gitlab.com.'],
        links: [{ label: 'Sign up for GitLab', url: 'https://gitlab.com/users/sign_up' }],
        check: 'You are signed in and can open “New project”.',
      },
      {
        title: 'Create the project',
        lines: [
          'Click “New project” → “Create blank project”.',
          'Project name: paste the value below.',
          'Visibility: Public. Keep “Initialize repository with a README”.',
          'Click “Create project”.',
        ],
        copies: [{ label: 'Project name', value: 'vibeshare-data' }],
        check: 'The project page is open with a README.md in the file list.',
      },
      {
        title: 'Add the page and the pipeline that publishes it',
        lines: [
          'Click “+” → “New file”. Name it public/index.html, paste the HTML below, then commit.',
          'Add .gitlab-ci.yml at the repository root with the pipeline below, then commit.',
        ],
        files: [
          { path: 'public/index.html', language: 'html', text: STARTER_HTML, note: 'The same HTML goes at public/public/index.html too: the base URL ends in the content folder (public) while Pages publishes the public folder as the site root.' },
          { path: '.gitlab-ci.yml', language: 'yaml', text: 'pages:\n  script:\n    - echo "Publishing public/"\n  artifacts:\n    paths:\n      - public' },
        ],
        check: 'public/index.html, public/public/index.html and .gitlab-ci.yml are all listed in the project files.',
      },
      {
        title: 'See your site',
        lines: [
          'The project page address reads gitlab.com/<userid>/<projectname> — those two values fill the first fields. Under Deploy → Pages GitLab shows the site address; its first part holds the six-character id for the last field.',
          'The site may take a few minutes to go live after the first commit.',
        ],
        fields: ['namespace', 'project', 'uniqueId'],
        fieldsFirst: true,
        copies: [],
        check: 'The address GitLab shows opens your index.html — not a 404.',
      },
    ],
    fields: [
      { id: 'namespace', label: 'User or group', placeholder: 'yourname', hint: 'The path your project lives under (gitlab.com/<userid>/<projectname>).' },
      { id: 'project', label: 'Project name', placeholder: 'vibeshare-data', hint: 'The project path — the last part of the project page address.' },
      {
        id: 'uniqueId',
        label: 'Unique domain id',
        placeholder: '7bd6b8',
        optional: true,
        hint: 'The six characters at the end of the unique domain GitLab shows under Deploy → Pages. Only needed for the unique domain type; a pasted unique domain fills it in.',
      },
      {
        id: 'urlType',
        label: 'URL type',
        default: 'project',
        custom: true,
        options: [
          {
            value: 'project',
            label: 'Project site',
            optionLabel: (values) => `Project site — ${gitlabBaseUrl({ ...values, urlType: 'project' }) || 'https://<userid>.gitlab.io/<projectname>/<folderpath>/'}`,
          },
          {
            value: 'unique',
            label: 'Unique domain',
            optionLabel: (values) => `Unique domain — ${gitlabBaseUrl({ ...values, urlType: 'unique' }) || 'https://<project>-<uniqueId>.gitlab.io/<folderpath>/'}`,
          },
        ],
        hint: 'The address shape this site is served under — “Check URLs” finds it by itself; picking one here keeps that choice.',
      },
      { id: 'branch', label: 'Branch', default: 'main', hint: 'The branch the pages job runs on (Manage → Repository → Branches).' },
      {
        id: 'folder',
        label: 'Folder for content ids',
        default: 'public',
        hint: 'The folder content ids live under, in the address and in the repository: the file lands at public/<folder>/<cid> (one level under the folder Pages publishes) and is served at <folder>/<cid>.',
      },
      { id: 'token', label: 'Access token', secret: true, hint: 'Avatar → Edit profile → Access → Personal access tokens, scope api (read-write).' },
    ],
    // Both shapes end in the folder: content ids live at <folder>/<cid> inside the
    // published site (the repository holds them at public/<folder>/<cid>, and Pages
    // publishes the public folder as the site root), so <base>/<cid> always carries the
    // folder and hash-verifies. The unique type trades the long project path for the
    // unique domain <project>-<six-digit-id>.gitlab.io — same site, no redirect.
    buildBaseUrl: gitlabBaseUrl,
    // The step-1 site check probes the site root — without the folder, which only holds
    // content ids, never an index of its own.
    // The site check probes the content folder's own index — <base>/index.html — so a
    // root index that answers while the folder path is broken cannot pass for the site.
    buildSiteUrl: (values) => gitlabBaseUrl(values),
    // Both shapes are parsed back into the fields — the unique domain one sets the URL
    // type and the six-character id from its host.
    parseBaseUrl: parseGitlabUrl,
    describeUrlShape: 'https://<userid>.gitlab.io/<projectname>/<folderpath>/\nhttps://<project-uniqueId>.gitlab.io/<folderpath>/',
    // The site check probes both address shapes at the content folder: whichever answers
    // 200 is the address this site is served under, and its urlType becomes the selected one.
    siteUrlCandidates: (values) =>
      (['unique', 'project'] as const)
        .map((urlType) => ({ url: gitlabBaseUrl({ ...values, urlType }), values: {} }))
        .filter((entry) => /^https?:\/\//.test(entry.url)),
    // Wired: commits each content id with the GitLab files API (POST or PUT
    // /api/v4/projects/<id>/repository/files/<path>, authenticated with PRIVATE-TOKEN).
    publish: 'gitlab',
};
