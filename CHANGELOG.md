# Changelog

## @arch-map/viewer 1.1.0 — 2026-11-16

Spec schema 1.4 (documents of 1.0–1.3 load unchanged):

- `glyphs[].tone` (`ok`, `warn`, `bad`, `muted`): a facet colors its tiles and their labels.
- Element `order` and `row`: siblings stand in the declared order on their parent's board, and a change of `row`
  starts a new row.
- `edgeStyles` (`facet`, `dash`: solid / dashed / dotted, `role`, `planned`): relations carrying a facet are drawn
  dashed or dotted, each style is a filter in the legend; planned relations (not in the code yet) are fainter and
  listed under Planned.

## @arch-map/viewer 1.0.2 — 2026-11-16

- Trackpad pinch zooms the map in Safari: WebKit's gesture events become the same pinch as Chrome's ctrlKey wheel
  (same limiter, one focus level per gesture, toward the fingers); a browser sending both is not zoomed twice.

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
