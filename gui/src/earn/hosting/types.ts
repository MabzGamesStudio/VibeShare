// The types the earn wizard is built from: what a platform declares, what one step
// holds, and what the wizard keeps between visits.

/** One input of a platform's setup form. */
export interface HostingField {
  id: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** Access tokens and API keys: shown as a password field. */
  secret?: boolean;
  default?: string;
  /** Fixed choices for this field: shown as a dropdown instead of a text input. */
  options?: { value: string; label: string; /** Rebuilt per render from the current values (labels that show the typed URL). */ optionLabel?: (values: Record<string, string>) => string }[];
  /** Only needed for one of the platform's variants — the filled-check never demands it. */
  optional?: boolean;
  /** Rendered by the wizard's own UI (never as a leftover field of another panel). */
  custom?: boolean;
}

/** One step of a platform's setup: what to do in order, what to copy instead of typing,
 * and the check that ends the step — so the reader knows exactly what they have when
 * they tick it off.
 */
export interface HostingStep {
  /** Short title, e.g. "Create the repository". */
  title: string;
  /** The exact clicks and pastes in order — one line each, nothing assumed. */
  lines: string[];
  /** Values to copy instead of typing (names, URLs, commands, policies). */
  copies?: { label: string; value: string }[];
  /** Pages to open in this step. */
  links?: { label: string; url: string }[];
  /** Field ids this step fills in: their inputs are shown right under it. */
  fields?: string[];
  /** A starter to download instead of making by hand: a zip of these files — or the file
   * itself when there is one and its name is not a .zip. */
  download?: { label: string; zip: string; entries: { path: string; text: string }[] };
  /** File contents to copy into the repository, one highlighted block per file. */
  files?: { path: string; language: 'html' | 'yaml'; text: string; note?: string }[];
  /** The fields come before the instructions (the reader fills them in first). */
  fieldsFirst?: boolean;
  /** What you have when this step is done. The reader ticks it off. */
  check: string;
}

/** A free hosting platform: its signup, its setup steps and the fields its base URL needs. */
export interface HostingPlatform {
  id: string;
  name: string;
  /** Where to open the free account. */
  signup: string;
  /** Where the platform explains publishing a static site. */
  docs: string;
  /** The one line under the heading — left out when empty. */
  about?: string;
  /** How to create the account and get the site serving files, in order. */
  steps: HostingStep[];
  fields: HostingField[];
  /** The default published base URL from the entered values (with its trailing slash). */
  buildBaseUrl: (values: Record<string, string>) => string;
  /** The site root the panel-1 check probes (when the content folder may not exist yet). */
  buildSiteUrl?: (values: Record<string, string>) => string;
  /**
   * Parses a typed base URL back into the field values, so the fields and the base URL
   * stay in sync both ways. `null` means the address does not match this platform's
   * expected structure: the fields are then left untouched and the wizard warns instead
   * of guessing. `values` is the current state — it disambiguates shapes the address
   * alone cannot (GitHub's user site, GitLab subgroup paths).
   */
  parseBaseUrl?: (url: string, values: Record<string, string>) => Record<string, string> | null;
  /** What a matching base URL looks like — shown in the warning when an edited one does not. */
  describeUrlShape?: string;
  /**
   * The other addresses the step-1 site check accepts besides the site URL itself, for
   * platforms that serve one site under more than one address (GitLab's project site and
   * unique domain). Each candidate carries the field values it represents: when the
   * check finds the site at one of them, those values become the selected variant.
   */
  siteUrlCandidates?: (values: Record<string, string>) => { url: string; values: Record<string, string> }[];
  /** Which push pipeline this platform's `publish` runs; every one of them is wired up. */
  publish?: 'github' | 'gitlab' | 'netlify' | 'cloudflare' | 'vercel' | 'firebase' | 'render' | 'appwrite' | 'surge' | 'neocities' | 'codeberg' | 'aws' | 'azure' | 'gcloud';
}

/** A saved base URL: one platform account the user configured. */
export interface HostConfig {
  id: string;
  platform: string;
  /** User label, e.g. "My GitHub Pages". */
  label: string;
  /** Base URL with a trailing slash; content ids are appended to it. */
  baseUrl: string;
  /** What the platform's form was filled with (including any token). */
  values: Record<string, string>;
  /** Skeleton switch: push provider job data to the site automatically. */
  autoPush: boolean;
  createdAt: string;
}

export interface PushResult {
  ok: boolean;
  message: string;
  /** Where the pushed file is visible, when the platform answers with one. */
  url?: string;
}

/** What the wizard shows after the account setup, per platform. */
export interface PlatformGuide {
  /** Where each access detail comes from, one step per field group. */
  access: HostingStep[];
  /** The base URL and content ids of this platform. */
  url: HostingStep[];
  /** Saving the host, offering it and pushing the job's bytes. */
  save: HostingStep[];
}

/**
 * One job this client took: its bytes are hosted at the data hosting URLs (nothing is
 * kept on this machine) and the provider gets the full retrieved data from those URLs.
 * Entries appear only when the user actively creates or selects a job in the Provider
 * jobs tab or uploads it with the URL jobs card — never automatically.
 */
export interface UrlJobEntry {
  id: string;
  cid: string;
  title?: string;
  /** The provider node the job came from. */
  source: string;
  /** Host labels the bytes were uploaded to. */
  hosts: string[];
  /** The URL that serves the full retrieved data. */
  url: string;
  at: string;
}

/** What the setup wizard holds between visits: every field, per platform. */
export interface HostDraft {
  values: Record<string, string>;
  /** Which steps are ticked off, per step group (account/access/url/save): the checklist survives a reload. */
  done?: Record<string, boolean[]>;
  /** The base URL typed over the one the fields build (empty = built from the fields; a
   * typed one is kept verbatim while its parsed fields follow it). */
  baseUrl: string;
  label: string;
  cid: string;
}
