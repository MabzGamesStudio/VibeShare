// The platform API adapters, one module per platform. This barrel keeps exactly the
// list the crawler works from — the same adapters, in the same order, there has
// always been.
import { vimeo } from './vimeo.js';
import { twitch } from './twitch.js';
import { unsplash } from './unsplash.js';
import { pexels } from './pexels.js';
import { giphy } from './giphy.js';
import { tenor } from './tenor.js';
import { imgur } from './imgur.js';
import { deviantart } from './deviantart.js';
import { europeana } from './europeana.js';
import { reddit } from './reddit.js';
import { tumblr } from './tumblr.js';
import { x } from './x.js';
import { instagram } from './instagram.js';
import { spotify } from './spotify.js';
import { jamendo } from './jamendo.js';
import { freesound } from './freesound.js';

export { vimeo, twitch, unsplash, pexels, giphy, tenor, imgur, deviantart, europeana, reddit, tumblr, x, instagram, spotify, jamendo, freesound };

export const API_ADAPTERS = [vimeo, twitch, unsplash, pexels, giphy, tenor, imgur, deviantart, europeana, reddit, tumblr, x, instagram, spotify, jamendo, freesound];
