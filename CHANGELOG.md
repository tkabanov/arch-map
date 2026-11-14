# Changelog

## 1.0.0 — unreleased

First public release.

- Interactive 3D map drawn from spec documents (JSON, schema `specs/schema/spec.schema.json`, version 1.x): client
  layer, focus and autofocus, Path, scenarios and the cinema, envelopes, contracts, search, light and dark themes.
- Stack adapters: NestJS (backend and TypeScript frontends), Supabase (Postgres snapshot, Edge Functions, React
  clients, the platform).
- Projects as folders with a `project.json` manifest; two invented example projects in `examples/`.
- Checks: schema and set validation, boundary (without facets), determinism, architecture and neutrality rules.
- `@arch-map/viewer`: `mount()`, the `<arch-map>` element, a React wrapper and a single-script build.
