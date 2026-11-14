# CLAUDE.md

arch-map: an interactive 3D map of a codebase's architecture, generated from its code. `AGENTS.md` is the entry point
(layout, commands, rules); `README.md` has the design and the controls.

- **Projects** are read from the directory named by `ARCH_MAP_PROJECTS` (`.env.local`, see `.env.example`); unset, it
  is `examples/` of this repo. The core (`scripts/`, `viewer/src/`, `types/`, `test/*.ts`) names no project —
  `npm run check:neutral` enforces it. Adding a project: `docs/adding-a-project.md`; a new stack: `docs/adding-a-stack.md`.
- **Trackpad:** pinch is limited in `MapControls` (`viewer/src/scene-controls.ts`, rules in `viewer/src/input.ts`) and
  depends on three 0.186.1 internals; bumping three requires `npm run test:browser -- pinch wheel`
  (`docs/browser-checks.md`).
- **Verify UX in a real browser with real input** (Playwright `page.mouse.wheel`, hover, clicks), not only synthetic
  events; zoom thresholds were tuned that way (~6 wheel notches per level).
- Before a commit: `npm run check:fast`; CI runs `npm run check:all`.
