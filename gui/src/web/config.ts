import type { WebConfig } from './backend';

/** Reads config.json next to the web client (missing or broken: no defaults). */
export async function loadConfig(base: string): Promise<WebConfig> {
  try {
    const response = await fetch(new URL('config.json', base), { cache: 'no-cache' });
    if (!response.ok) return {};
    const config = (await response.json()) as WebConfig;
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}
