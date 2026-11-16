# Contributing

Thanks for your interest in arch-map. Issues and pull requests are welcome.

## Setup

Node.js 22.18 or later. From a checkout:

```bash
npm ci
npm run viewer        # http://localhost:4848, the example projects in examples/
```

The code is TypeScript throughout and runs without a build step (Node type stripping; Vite for the viewer).
`AGENTS.md` is the short map of the repository: the three levels (core, stacks, projects), the pipeline and the rules.

## Before you open a pull request

```bash
npm run check:fast    # types, tsc ratchet, lint, complexity ratchet, architecture rules, neutrality — a few seconds
npm run check:all     # the tests and checks CI runs
npm run check:determinism   # CI too: regenerates examples/; commit the specs if they change
```

- **The core names no project.** `scripts/`, `viewer/src/`, `types/` and `test/*.ts` must stay generic;
  `npm run check:neutral` and `npm run check:arch` enforce it. Project-specific code belongs in a project folder.
- **Ratchets only go down.** `quality/*-baseline.json` record today's debt; never raise a baseline to get green — fix
  the code, or lower the baseline with `--update` when you improved it (`docs/code-quality.md`).
- **Generators only read the target code.** Snapshots hold structure (names, definitions), never data, and redact secret-like strings; that redaction is a pattern match, so review a snapshot diff before committing it.
- **UX changes are checked in a real browser with real input** (wheel, hover, clicks): `npm run test:browser`
  (`docs/browser-checks.md`). Say in the pull request what you checked and how.
- **Spec format changes** go through `specs/schema/spec.schema.json`, `npm run types` and `specs/README.md`;
  the decisions behind the format are in `docs/architecture.md`.
- Everything is in English: UI text, docs, comments, generator strings.

## Where to start

- A new project (map your own codebase): `docs/adding-a-project.md`.
- A new technology: `docs/adding-a-stack.md`.
- Embedding the map in a page: `docs/embedding.md`.

## Releases (maintainers)

- **arch-map:** bump `version` in `package.json`, add a section `## <version> — <date>` to `CHANGELOG.md`, push the
  tag `v<version>`. `.github/workflows/release.yml` makes the GitHub release from that section.
- **`@arch-map/viewer`:** bump `version` in `packages/viewer/package.json` (its major is the spec schema's), push the
  tag `viewer-v<version>`. `.github/workflows/publish-viewer.yml` stages it on npm and makes the GitHub release; the
  version goes live on npm once a maintainer approves it with 2FA in npmjs.com → Staged Packages.

By contributing you agree that your contributions are licensed under the MIT License of this repository.
