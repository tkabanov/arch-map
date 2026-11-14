# AGENTS.md

arch-map generates an interactive 3D map of a system's architecture from its code and renders it in a browser. The
generators write **specs** (JSON, `<projects dir>/<project>/specs/`); the viewer and AI agents read only the specs.
The core knows no project: it reads them from a projects directory (env `ARCH_MAP_PROJECTS` in `.env.local`; default
`examples/`); each project is a self-contained folder there, adding one does not touch the core. Detail: `README.md`.

## Layout — three levels, dependencies point down only

| Level | Where | Knows |
|---|---|---|
| core | `scripts/`, `viewer/src/` (incl. `viewer/src/core/`, pure, no DOM/Node), `types/`, `test/*.ts` (on `test/fixtures/`), `specs/schema/` | no project name (`npm run check:neutral` enforces it) |
| stacks | `scripts/stacks/{nest,supabase}/` (entry point `index.ts` each) | one technology; every id/value comes from the project config |
| projects | `<projects dir>/<p>/` (`project.json`, `config.ts`, `generate.ts`, `sources/`, `test/`, `specs/`) | one system |

Pipeline: generator → `<projects dir>/<p>/specs/*.json` → `scripts/check-specs.ts` (validate + merge) → `scripts/publish-specs.ts` → `viewer/`.
Project code imports the core only by package name — `arch-map/stacks/<s>`, `arch-map/generator`, `arch-map/testing`,
`arch-map/core`, `arch-map/viewer/<module>`, `arch-map/types/<file>` (package.json `exports`; `check:arch` enforces it).
The code is TypeScript throughout and runs on Node ≥ 22.18 without a build step (type stripping); the viewer is Vite + three.js.

## Commands

```bash
npm ci
npm run viewer                  # http://localhost:4848, the committed specs of the projects dir (no target checkout needed)
npm run check:fast              # a few seconds: types, tsc ratchet, lint, complexity ratchet, architecture, neutrality — run before every commit
npm test                        # unit tests (a few seconds)
npm run check:all               # everything that runs from this checkout alone (~15 s); this is what CI runs
npm run gen -- <project>        # regenerate one project's specs from its code (needs the target codebase the project reads, see its `project.json#env`)
npm run snapshot -- <project> [kind]   # refresh a committed snapshot (also needs the external checkout)
npm run test:browser            # real-Chromium UX checks; slow, not part of check:all
npm run lib:build               # the package @arch-map/viewer (mount() anywhere) into packages/viewer/ — docs/embedding.md
```

`check:determinism -- <project>` regenerates and diffs; a project of your own needs its external checkouts, so it is not in
`check:all`. CI also runs it on `examples/` (they need none) and fails when the committed specs differ from a fresh generation.

## Rules

- Code-quality rules, conventions, the ratchets (`quality/*-baseline.json`), architecture rules: `docs/code-quality.md`.
  Never raise a baseline to get green — fix the code, or lower the baseline when you improved it (`--update`).
- Spec format (for agents that read or write specs): `specs/README.md`, plus each project's `specs/README.md`; the schemas (spec, project manifest) in `specs/schema/`.
- Layer boundaries are enforced by `.dependency-cruiser.cjs` (`npm run check:arch`); no project names in the core.
- The generators only read the target codebases and never write there. Snapshots hold structure (names, definitions), never data; redaction of secret-like strings is best-effort, so a snapshot is reviewed before it is committed.
- Shared shapes live in `types/`, not in JSDoc. `types/spec.d.ts` is generated (`npm run types`).
- UX changes are verified in a real browser with real input (wheel, hover, clicks), see `docs/browser-checks.md`.
- Everything is English: UI text, docs, comments, generator strings.

## Where to read next

`README.md` (overview, controls) · `docs/architecture.md` (the decisions) · `specs/README.md` (spec format) ·
`docs/code-quality.md` (quality tooling) · `docs/browser-checks.md` (browser checks) · `docs/adding-a-project.md` ·
`docs/adding-a-stack.md`.
