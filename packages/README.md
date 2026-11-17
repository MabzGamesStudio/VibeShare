# Shared packages: @vibeshare/protocol and @vibeshare/sources

Two small packages that give forks and alternative implementations (Go/Rust/Python
ports, or plain JS tooling) a **stable import specifier** for the protocol wire types
and the source/content-id building blocks:

- `@vibeshare/protocol` — node info, accounts, content, storage, peering and client API
  wire types (`src/shared/protocol/` behind `src/shared/protocol.ts`).
- `@vibeshare/sources` — content ids (`vs1…`/`vc1…`), external source ids (`yt:…`),
  the scheme registry, URL → canonical source parsing and embed builders
  (`src/shared/sources.ts`).

## Layout choice: re-export barrels over the canonical modules

Each package is a **barrel that re-exports the canonical module** (`export * from
'../../src/shared/protocol.js'`), with `package.json` `exports` pointing at that
barrel. Why this and not a copied tree or a compiled `dist`:

- **No duplication, no drift.** The canonical modules stay in `src/shared/`; the
  package is a naming surface over them. A fork vendoring the repo (or a future
  publish step) gets the exact code the network runs.
- **Lowest churn.** Nothing in the app's runtime moved or changed; the app does not
  even import these packages yet — its imports keep working unchanged.
- **Works with the repo's NodeNext resolution.** The barrels use the same `./x.js`
  import style as the rest of `src/`, and `npm run check:packages` typechecks both
  packages under the root tsconfig's settings.

For publication to a registry, a `build` step would compile the barrels (and their
transitive `src/shared` graph) into `dist/` with declaration files and point
`exports` at `./dist/index.js` — the barrel layout is exactly what that step compiles.

## Buildable but unpublished (and why there are no npm workspaces — yet)

The packages are **not** wired into npm workspaces yet: adding `"workspaces"` to the
root manifest would make the next `npm install` rewrite `package-lock.json` and link
the packages into `node_modules`, which is a repository-wide change that belongs in a
dedicated commit (with the regenerated lockfile and CI checks), not mixed into this
one. Until then:

- `npm run check:packages` typechecks both packages (also proves the barrels resolve
  under the repo's compiler settings).
- Nothing in the app, tests or build depends on the package names, so nothing breaks
  in the meantime.

To finish the wiring later: add `"workspaces": ["packages/*"]` to the root
`package.json`, run `npm install` (committing the lockfile), and optionally add a
per-package `build` that emits `dist/` + `types`.

## For non-JS implementations

The TypeScript declarations are the normative shape of the wire format; port them
one-to-one. Behavior beyond the types (validation rules, hashing, comment chains) is
specified by the code and the tests — and the **crawler-adapter conformance suite**
in `tests/conformance/` gives alternative adapters a semantic, offline fixture set to
check themselves against (see `tests/conformance/README.md`).
