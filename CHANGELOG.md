# Changelog

## 0.0.1 — 2026-11-14

First public release.

- Interactive 3D map drawn from spec documents (JSON, schema `specs/schema/spec.schema.json`, version 1.x): client
  layer, focus and autofocus, Path, scenarios and the cinema, envelopes, contracts, search, light and dark themes.
- Stack adapters: NestJS (backend and TypeScript frontends), Supabase (Postgres snapshot, Edge Functions, React
  clients, the platform).
- Projects as folders with a `project.json` manifest; two invented example projects in `examples/`.
- Checks: schema and set validation, boundary (without facets), determinism, architecture and neutrality rules.
- `@arch-map/viewer`: `mount()`, the `<arch-map>` element, a React wrapper and a single-script build.
  The package version follows the spec schema's major (1.x), not the repository's version; on npm as `@arch-map/viewer`.
- A demo site on GitHub Pages (`site/`, `npm run pages:build`): https://tkabanov.github.io/arch-map/
