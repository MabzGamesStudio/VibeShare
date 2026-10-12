# VibeShare web client

`web/` is the VibeShare client as a static website: the same app as the desktop client (pages, shorts, search, subscriptions, publishing, credits, sharing), with a hash router so any static host can serve it, GitHub Pages included. Shared links and QR codes open it on the shared content:

```
https://mabzgamesstudio.github.io/WebPages/pages/vibeShare/web/#/watch/<content id>
```

There is no server behind it. The client's backend runs in the visitor's browser, in a service worker: it keeps the visitor's keys, node list and settings in the browser, talks to provider and algorithm nodes directly, checks every chunk against its hash and streams video with seeking, exactly like the desktop client does.

## What is in here

| | |
|---|---|
| `config.json` | What a first-time visitor starts with: the nodes to add and where shared links point. Copied into `web/` by the build. |
| `web/` | The built site: `index.html`, `assets/`, `sw.js` (the service worker), `config.json`, `.nojekyll`. Commit it after building; CI checks that it matches the sources. |

## Point it at your nodes

Replace the placeholders in `config.json` with the references of your provider and algorithm nodes (each node prints its reference when it starts; `vibeshare info --data <data dir>` prints it too):

```json
{
  "shareBaseUrl": "https://mabzgamesstudio.github.io/WebPages/pages/vibeShare/web",
  "defaultNodes": [
    "vs:provider:vk1…@https://cdn.example.org",
    "vs:algorithm:vk1…@https://feed.example.org"
  ]
}
```

- `defaultNodes` are added on a visitor's first visit (nodes that are offline then are added anyway and checked again later). Visitors can add, remove and reorder nodes afterwards like in the desktop app; references that do not parse (like the placeholders) are skipped.
- `shareBaseUrl` is where shared links and QR codes point. Without it, they point to wherever the site is hosted. Visitors can change it in *Settings → Sharing*, like desktop users.
- `config.json` can also be edited in the hosting repository without rebuilding; it applies to browsers that have not opened the client yet.

The nodes must be reachable from browsers **over HTTPS**: an https page may not call http addresses (except on the visitor's own computer). Put each node behind a reverse proxy with TLS ([docs/OPERATORS.md](../docs/OPERATORS.md)). Node APIs already accept cross-origin requests from any site (they authenticate with tokens, never cookies).

## Build

```bash
npm install && npm --prefix gui install
npm run build:web          # writes distribution/web
```

To try it locally, serve the folder over http on localhost (service workers need https or localhost), for example `npx http-server distribution/web -p 8090`, and open http://localhost:8090. With `vibeshare demo` running, put the demo's two references (printed at start) in `config.json` first.

## Publish on GitHub Pages

Copy the contents of `web/` (including the hidden `.nojekyll`) into the `VibeShare/` folder of the Pages repository and push:

```bash
rsync -a --delete distribution/web/ ../WebPages/pages/vibeShare/web/
cd ../WebPages && git add pages/vibeShare/web && git commit -m "Update VibeShare" && git push
```

Or let GitHub Actions do it: add a repository secret `WEBPAGES_TOKEN` (a fine-grained token with *Contents: read and write* on the Pages repository), then run the **Web client** workflow by hand. It builds the site and pushes it to `MabzGamesStudio/WebPages`, folder `pages/vibeShare/web` (both can be changed when starting the run). On pushes to `main` the workflow only builds the site and keeps it as a downloadable artifact.

## Good to know

- **Keys live in the browser.** Each visitor gets an identity on their first visit, stored in the site's IndexedDB. Clearing the site's data deletes it: *Settings → Identity* shows the backup, which restores it in any client (web or desktop).
- **The origin is shared.** Everything under `https://mabzgamesstudio.github.io/` is one origin, so every Pages site of the account can read what the web client stores. Only host pages you trust there, or give the web client its own domain.
- **Earning by storing data** for providers needs a client that keeps running, so it is only in the desktop app and `vibeshare client`.
- **Without service workers** (some private windows, plain http), the backend runs in the page instead: everything works, but videos load completely before they play.
