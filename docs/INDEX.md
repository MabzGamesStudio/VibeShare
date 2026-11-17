# Documentation index

Every document in the repository, in reading order. Start with the README for
the overview; pick the guide that matches what you are doing.

| Document | What it covers | For whom |
|---|---|---|
| [README.md](../README.md) | What VibeShare is, the three node types, install and run in one page, links to everything else | Everyone, first contact |
| [QUICKSTART.md](QUICKSTART.md) | Installing and first run per OS (desktop app, command line, Docker, from source, the demo network) | New users and operators |
| [CLIENT.md](CLIENT.md) | The client app: pages, watch, publish, earning credits, settings, profiles, privacy features, the web and iOS builds | Users |
| [NODES.md](NODES.md) | Running provider and algorithm nodes: configuration, the admin console, storage, tiers, peering, payments, crawling | Node operators |
| [OPERATORS.md](OPERATORS.md) | The operator's reference: every configuration key, Tor, payment methods, storage backends and the storage service in detail, the crawler and platform APIs, the security checklist | Node operators, deep dives |
| [PROTOCOL.md](PROTOCOL.md) | The wire protocol: identifiers, node info, accounts, credits, every route of every node type and the client daemon, as tables | Client/node implementers |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The codebase: module map, import graph, the browser/Node boundary, where each kind of change goes, a navigation guide for AI assistants | Contributors |
| [EXTENDING.md](EXTENDING.md) | Every extension point with a worked example: ranking modules, storage backends, payment methods, crawler adapters, hosting platforms, page presets, moderation | Contributors, tinkerers |

## Elsewhere in the repository

| Document | What it covers |
|---|---|
| [distribution/README.md](../distribution/README.md) | Building and hosting the static web client (`distribution/config.json`, `npm run build:web`) |
| [mobile/README.md](../mobile/README.md) | The iOS app (Capacitor shell around the web client; sideloading, TestFlight) |
| [examples/](../examples) | Example node configs, a custom ranking module (`examples/ranking/ranker.mjs`), systemd units |
| [docs/images/](images) | Screenshots used by the documentation |

## Quick answers

- *How do I install it?* → [QUICKSTART.md](QUICKSTART.md)
- *What do the client pages do?* → [CLIENT.md](CLIENT.md)
- *How do I run a node?* → [NODES.md](NODES.md) · *What is every config key?* → [OPERATORS.md](OPERATORS.md)
- *What is the API?* → [PROTOCOL.md](PROTOCOL.md)
- *Where in the code do I add X?* → [ARCHITECTURE.md](ARCHITECTURE.md) · [EXTENDING.md](EXTENDING.md)
