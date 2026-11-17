// Every platform the wizard offers, collected in the order the tabs show them.
import type { HostingPlatform } from '../types';
import { github } from './github';
import { cloudflare } from './cloudflare';
import { gitlab } from './gitlab';
import { netlify } from './netlify';
import { vercel } from './vercel';
import { firebase } from './firebase';
import { render } from './render';
import { appwrite } from './appwrite';
import { surge } from './surge';
import { neocities } from './neocities';
import { codeberg } from './codeberg';
import { aws } from './aws';
import { azure } from './azure';
import { gcloud } from './gcloud';

export const HOSTING_PLATFORMS: HostingPlatform[] = [github, cloudflare, gitlab, netlify, vercel, firebase, render, appwrite, surge, neocities, codeberg, aws, azure, gcloud];

export function hostingPlatform(id: string): HostingPlatform {
  return HOSTING_PLATFORMS.find((platform) => platform.id === id) ?? HOSTING_PLATFORMS[0];
}
