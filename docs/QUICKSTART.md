# Quickstart

Install VibeShare and get to a working app in a few minutes, on any OS. What each
part does is in [CLIENT.md](CLIENT.md) (the app) and [NODES.md](NODES.md) (the
server nodes); this page only gets you running.

## 1. Get it

Releases are built by GitHub Actions when a `v*` tag is pushed (see
[`.github/workflows/release.yml`](../.github/workflows/release.yml)). Pick your
OS:

| | macOS | Linux | Windows |
|---|---|---|---|
| **Desktop app** (client) | `VibeShare-…-mac-arm64.dmg` / `-x64.dmg` | `.AppImage`, `.deb`, `.tar.gz` | `VibeShare-…-win-x64.exe` installer or `.zip` |
| **Command line** (every node type, GUI included) | `vibeshare-…-macos-arm64` / `-x64` | `vibeshare-…-linux-x64` / `-arm64` | `vibeshare-…-windows-x64.exe` |
| **32-bit Linux server nodes** (provider + algorithm) | | `vibeshare-…-linux-ia32.tar.gz` / `linux-armv7l.tar.gz` | |
| **Docker** (provider, algorithm) | `ghcr.io/mabzgamesstudio/vibeshare` | same | same |
| **iPhone and iPad** | `VibeShare-unsigned.ipa` from the *iOS app* workflow (install with AltStore or Sideloadly), or TestFlight — see [mobile/README.md](../mobile/README.md) | | |
| **Web client** (no install) | [mabzgamesstudio.github.io/WebPages/pages/vibeShare/web](https://mabzgamesstudio.github.io/WebPages/pages/vibeShare/web/) — any browser | same | same |

Or install the command-line build in one line:

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/MabzGamesStudio/VibeShare/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/MabzGamesStudio/VibeShare/main/scripts/install.ps1 | iex
```

Notes that save support time:

- The binaries are not code-signed yet: on macOS the installer clears the
  quarantine flag (or right-click → Open once); on Windows choose
  *More info → Run anyway* in SmartScreen.
- The 32-bit Linux archives are server-only packages with a bundled Node runtime
  and `vibeshare-provider` / `vibeshare-algorithm` launchers, for 32-bit x86
  (`linux-ia32`) and 32-bit ARM (`linux-armv7l`). The x86 archive bundles Node
  20.19.5; ARMv7 bundles Node 22.23.4. Install FFmpeg with `libvpx-vp9` and
  `libopus` there for provider video conversion.

## 2. First run

The fastest way to see everything is the demo — a whole network on your machine:

```bash
vibeshare demo --open
```

It starts a provider (:7701), an algorithm node (:7702) and a client (:7700)
with generated sample content: vertical shorts, a video, artwork, music, an
article, content that only exists on external platforms, a content id whose
providers are gone (fallback in action) and a blocked scam post. When online,
the algorithm node's crawler adds content from other platforms too. It prints
the operators' admin tokens and two voucher codes to top up credits. Data lives
in your app-data folder under `demo`; `--data <dir>` moves it. `--malicious`
adds a second client and corrupt provider/algorithm servers for testing
verification (developer use only).

Or run just what you need:

```bash
vibeshare client --open        # just the client: the app in your browser
vibeshare provider --public-url https://cdn.example.org
vibeshare algorithm --public-url https://feed.example.org
vibeshare info                 # print the reference + admin token of a data directory
vibeshare --help
```

Ports: client **7700**, provider **7701**, algorithm **7702** (override with
`--port`). Provider and algorithm nodes print their **reference** (share it so
clients can add them), their `/admin` dashboard address and the admin token on
first start. Full command and flag reference: `vibeshare --help`, or
[NODES.md](NODES.md) for the operator side and [CLIENT.md](CLIENT.md) for the app.

## 3. From source (Node.js 22+)

```bash
npm install && npm --prefix gui install
npm run build                # compiles the nodes (dist/) and the GUI (gui/dist/)
node dist/cli.js demo --open
```

Desktop app from source: `npm run build && cd desktop && npm install && npm start`
(`npm run dist` builds installers for the current OS).

Day-to-day development commands live in
[ARCHITECTURE.md](ARCHITECTURE.md#how-to-navigate-for-an-ai-assistant); the short
version: `npm test`, `npm run typecheck`, `npm run demo`, `npm run client` /
`provider` / `algorithm`, `npm --prefix gui run dev` (Vite on :5173 proxying to a
client on :7700 — open with `?t=<token>`, the token is in the page's `vs-token`
meta tag).

## 4. Server deployment extras

- **Docker:** `docker compose up -d` runs a provider and an algorithm node
  ([docker-compose.yml](../docker-compose.yml)).
- **systemd:** unit files in [examples/systemd](../examples/systemd).
- **Behind a reverse proxy** (Caddy, nginx, Traefik): set `publicUrl` and
  `trustProxy: true` — see [OPERATORS.md](OPERATORS.md).
- **Tor:** nodes can publish a `.onion` address with `--onion` (no public
  address or open port needed) — see [OPERATORS.md](OPERATORS.md#tor).

## Next steps

- Using the app → [CLIENT.md](CLIENT.md)
- Running nodes for real → [NODES.md](NODES.md) and [OPERATORS.md](OPERATORS.md)
- What travels over the wire → [PROTOCOL.md](PROTOCOL.md)
