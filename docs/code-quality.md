# Code quality

The tools, the ratchets, the architecture rules and the conventions of this repository. Run `npm run check:fast` before
every commit and `npm run check:all` before merging.

## Checks

| Command | What it does |
|---|---|
| `npm run check:types` | `types/spec.d.ts` matches the schema (`npm run types` regenerates it) |
| `npm run check:tsc` | type check (strict), a ratchet — see below |
| `npm run lint` | ESLint (flat config); `npm run lint:prune` shrinks `eslint-suppressions.json` |
| `npm run check:warnings` | size and complexity warnings as a ratchet |
| `npm run check:arch` | import rules (dependency-cruiser) |
| `npm run check:neutral` | the generic core names no project |
| `npm test` | unit tests |
| `npm run check` | the specs of every project as a set of its own |
| `npm run check:boundary` | the specs are valid and answer the same without facets; the viewer reads facets in two files only |
| `npm run check:all` | all of the above, without stopping at the first failure; prints a table of ok/FAIL and seconds; exit 1 if any failed |
| `npm run check:fast` | the static ones: types, `tsc`, lint, warnings, arch, neutral — seconds, same `file:line` output |
| `npm run quality:report` | complexity and length report (`-- --top 40`, `-- --json`) |

`check:determinism` is not in `check:all`: it regenerates from the target codebases, which a project's `project.json#env`
names, so run it separately when they are at hand.

## Ratchets

A check that is red on existing debt gets ignored; a warning nobody fails on grows. The ratchets record today's debt in a
baseline file and fail only on **new** problems. Never raise a baseline to get green: fix the code, or lower the baseline
when you improved it.

- **`check:tsc`** fails when the total error count grows over `quality/tsc-baseline.json` (it lists the files that grew).
  `-- --update` lowers the baseline, `-- --list` prints every error. Both `tsconfig.json` (Node + core) and
  `tsconfig.viewer.json` (DOM) are checked; a diagnostic both report counts once. Baseline keys are file paths, so after a
  rename `--update` drops the old key.
- **`check:warnings`** runs ESLint (JSON) and compares the warning counts with `quality/lint-warnings-baseline.json`, shaped
  `{ total, entries: { "<file>::<rule>": count } }`. It fails when a `file::rule` key is new or its count grows (the new
  warnings print as `file:line`) and when ESLint reports an error; it passes with a hint when counts shrink — run
  `node scripts/check-lint-warnings.ts --update` and commit the lower baseline. The granularity is file + rule, not per
  function, because a function's identity changes with renames and line shifts while a file + rule count does not move when
  other code in the file is edited.
- **`lint`** uses ESLint's bulk suppressions (`eslint-suppressions.json`): existing *errors* are recorded per file and rule,
  new ones fail. `--pass-on-unpruned-suppressions` lets a fixed suppressed error pass; `lint:prune` shrinks the file.

## ESLint

- Errors: `eslint:recommended`, `no-unused-vars` (a leading `_` opts out, as in `const { facets: _f, ...rest }`), `eqeqeq`
  (except `== null`), `no-var`, `prefer-const`, `@typescript-eslint/no-explicit-any`.
- Warnings (the ratchet): `complexity` 15, `max-depth` 4, `max-lines-per-function` 80 (without blank lines and comments),
  `max-lines` 600 (same), `max-params` 5, `max-nested-callbacks` 4, `no-shadow`. Tests are exempt from function length and
  callback nesting.
- `typescript-eslint` `recommended` (syntax only, no type-aware rules), limited to `**/*.ts`. Globals by directory: the
  viewer gets the browser, `scripts/` and `test/` get Node, `viewer/src/core/` gets nothing beyond the language and `console`.
- ESLint ignores `**/sources/`, `**/specs/`, `**/test/fixtures/` and `types/spec.d.ts`.

## Architecture rules (`.dependency-cruiser.cjs`)

Cruised by `scripts/check-arch.ts`: `scripts/`, `viewer/src/`, `test/`, `types/` and the active projects dir (env
`ARCH_MAP_PROJECTS`). The core's tests are cruised for resolvability only; they may import anything. Type imports are
cruised too (`import type` is dependency type `type-only`, `typeof import('…')` is `type-import`); the layer rules are about
what runs, so every rule except `generic-no-projects`, `project-no-other-project`, `stack-supabase-entry-only`,
`stack-supabase-entry-consumers` and `not-to-unresolvable` skips those two types, and `no-circular` is `viaOnly`.

| Rule | Says |
|---|---|
| `core-no-three` | `viewer/src/core/` imports no three.js |
| `core-no-node-builtins` | … no Node built-ins |
| `core-no-viewer` | … nothing outside `viewer/src/core/` (in particular no DOM-touching viewer module) |
| `core-no-packages` | … no npm package at all |
| `scripts-viewer-core-only` | `scripts/` import from `viewer/` only `viewer/src/core/` |
| `viewer-no-scripts` | the viewer does not import `scripts/` |
| `viewer-no-node-builtins` | the viewer imports no Node built-ins |
| `generic-no-projects` | `scripts/`, `viewer/src/` and `types/` never import a `.ts` of the projects dir, type imports included (a project config `satisfies` a stack config interface of `types/stacks/` instead) |
| `stack-nest-isolated`, `stack-supabase-imports`, `stack-no-other-stack` | a stack (`scripts/stacks/<s>/`) imports only itself, `scripts/lib/`, `viewer/src/core/` and `types/`; no stack imports another, type imports included |
| `lib-no-stacks` | `scripts/lib/` imports no stack |
| `project-core-via-package` | project code imports the core only by package name (`arch-map/…`), never by a relative path out of the projects dir |
| `project-public-api-only` | of the core, project code imports only what `package.json` `exports` maps |
| `project-code-no-test-surface` | a project's own code (tests aside) does not import `arch-map/testing` or `arch-map/viewer/*` |
| `project-no-other-project` | a project never imports another project |
| `no-circular` | no import cycles in `scripts/`, `viewer/` and the projects dir (cycles through type imports are allowed) |
| `not-to-unresolvable` | every import resolves |

A pitfall when writing such rules: `options.exclude: '^node_modules/'` silently drops every dependency *on* a package, so a
rule such as `core-no-three` could never fire. `doNotFollow` is the right option, `exclude` is not. Prove a new rule with a
throwaway probe file that must trip it.

The facet boundary stays in `check:boundary`, not here: it is a rule on property access, which dependency-cruiser cannot
express. A TypeScript AST guard over `viewer/src/**/*.ts` allows only `spec-adapter.ts` and `panel.ts` to read `facets`. It
reports direct and optional access, literal bracket keys, destructuring (including aliases, parameters and rest), and explicit
object properties forwarding `facets`. Spread of `el.facets` is rejected; opaque copies `{ ...el }` are allowed because they
forward core objects without interpreting facets. Comments, strings and type declarations are ignored.

### Supabase stack layers

The Supabase stack is split into layers; `supabase-<layer>-imports` rules enforce which internal runtime imports are allowed
(paths relative to `scripts/stacks/supabase/`).

| Layer (modules) | May import |
|---|---|
| Shared (`ids.ts`, `domains.ts`, `sources.ts`) | Shared |
| SQL / snapshot (`sql.ts`, `snapshot.ts`) | SQL / snapshot, shared |
| JS scanner (`supabase-js.ts`) | JS scanner, shared |
| Database builders (`db.ts`, `db-*.ts`) | Database builders, SQL / snapshot, shared |
| Edge Functions (`edge.ts`, `edge-*.ts`) | Edge Functions, JS scanner, shared |
| React client (`react-client.ts`, `react-client-*.ts`) | React client, JS scanner, shared |

No other stack imports the Supabase stack (`stack-no-other-stack`, type imports included). Projects may compose the stack's
builders and scanners; tests may import anything. New Supabase modules must be assigned to a layer (by file name, or by extending the rule patterns).

## TypeScript conventions

The code is TypeScript throughout and runs **without a build step**: Node's type stripping for `scripts/` and `test/`, Vite
for the viewer.

**Running.** A script runs as `node scripts/x.ts` (npm scripts keep `--env-file-if-exists=.env.local`): no flag, no loader,
no `tsx`. Node ≥ 22.18 strips types by default (`engines.node`). Do not add `--no-warnings`, which hides real warnings too.
`npm test` runs `scripts/test.ts`: the core's `test/*.test.ts` and every active project's `test/*.test.ts`.

**Erasable syntax only** (`erasableSyntaxOnly`): no `enum` (use a union of string literals or an `as const` object), no
`namespace`, no constructor parameter properties, no `import =` / `export =`, no decorators. Node refuses these at load time,
`tsc` refuses them first.

**Imports.**
- Relative imports carry the real extension: `import { tierOf } from './tier.ts'`. Never extensionless (Node does not resolve
  that).
- Types only: `import type { MergedSet } from '../../../types/core.ts'` (`verbatimModuleSyntax` makes `tsc` fail on a type
  imported without `type`; Node erases the line only when it says `type`). A separate `import type` line is preferred over
  the mixed form.
- Spec types: `import type { Edge, Element } from '…/types/spec.d.ts'` (type-only, so nothing is loaded at run time).
- Nothing generic imports a project, not even a type.

**Where types live.**
- Spec document shapes: `types/spec.d.ts`, generated from the schema (`npm run types`) — never edit by hand. The generator
  pre-processes the schema for `json-schema-to-typescript`: `if/then` guards (fields allowed only for some element types) are
  validation, not shape, and are dropped; an `if/then/else` that picks one of two shapes becomes a union.
- Shared shapes that the schema does not describe — anything another file consumes (the merged set, core results, the
  viewer's model, a generator's intermediate model): `types/*.ts`, one file per area: `core.ts`, `generator.ts` (what every
  generator shares), `stacks/{nest,supabase}.ts` (per stack, including the stack config interfaces), `project.ts`,
  `viewer.ts`, `scene.ts`. A `.ts`, not `.d.ts`: `skipLibCheck` skips every `.d.ts`, so a hand-written `.d.ts` is never
  checked.
- Function signatures are annotated **inline**. A type used inside one module only may be a local `interface`/`type`.
- **No JSDoc type annotations** (`@param {…}`, `@type`, `@returns {…}`); prose doc comments stay.

**Strictness.** `strict: true`. Where a strict fix would change behavior, use a narrow, honest type instead:
- an invariant the code relies on (a `Map.get` right after `has`) → non-null `!`, with a short comment when it is not obvious;
- a union the code tells apart by a property → a type guard, or `'key' in x`;
- when no honest type fits: `// TODO(types): <why>` and the narrowest cast that compiles. Never `@ts-ignore`;
  `@ts-expect-error` only with a reason.

**Boundaries and `any`.**
- `JSON.parse` of a spec → `as ArchMapSpecDocument` (the schema validated it, or the caller is about to); of other JSON → a
  named shape from `types/` or `unknown`, narrowed where read.
- Open JSON (contract documents, facets, envelopes) → `unknown`, narrowed where read.
- Loosely typed libraries: three ships no types, so `@types/three` is pinned to the same line as three; describe the node
  shapes an extractor reads from a loosely typed parser in `types/` and cast the parse result once, at the call.
- If `any` is truly needed (a generic visitor over foreign ASTs): `// eslint-disable-next-line
  @typescript-eslint/no-explicit-any -- <reason>`.

**Naming.** Types and interfaces `PascalCase`, no `I` prefix, no `T` prefix except generic parameters. Files are `.ts`, not
`.mts` (the package is `"type": "module"`).

**Docs.** When a file is renamed, update the docs that name it.

## Project homes

A project is a folder in the projects directory (`ARCH_MAP_PROJECTS`, default `examples/`); the decision is AD-16 in
`docs/architecture.md`, the how-to is `docs/adding-a-project.md`. The conventions that the tooling relies on:

**Where the projects are.** One setting: env `ARCH_MAP_PROJECTS` (in `.env.local`; every npm script that reads projects
loads it with `node --env-file-if-exists=.env.local`) names the projects directory — absolute, or relative to the checkout;
unset, `examples/`. It is canonicalized (`realpath`) by `projectsDir()`, the depcruise config and `check-arch.ts` alike:
depcruise reports imports by their physical path, so a symlinked dir (macOS `/var` → `/private/var`) must be spelled the same
way. It holds `index.json` (`order`, and `default` when `order` is not empty) and one self-contained folder per project; dot
folders and `node_modules/` are not projects. Only `scripts/lib/projects.ts` resolves it (`projectsDir()`, `loadProjects()`);
`.dependency-cruiser.cjs` repeats the three-line resolution because a `.cjs` config cannot import it. Zero projects is a valid
state: `npm test` runs the core's tests, the checks say "no projects" and pass, `publish-specs` writes an empty `projects.json`
and the viewer shows "No projects".

**A project folder** holds everything that knows one concrete project: `project.json` (manifests carry no `$schema`: no
relative path to the core works from a directory outside it), `config.ts`, `generate.ts`, snapshot scripts, `sources/`
(committed snapshots), `test/*.test.ts` and `test/fixtures/`, and `specs/` — its documents, `contracts/`, reports and README.
Every spec document's `$schema` is `../schema/spec.schema.json` (`SCHEMA_REF`, written by `writeSpec`): the published
tree's layout, so the bytes do not depend on where the project lives. The projects dir may also hold `tsconfig.json` (extends
`arch-map/tsconfig.json`; `check:tsc` runs it), `neutral-terms.json` (`{ "terms": [...] }`, extra words `check:neutral`
forbids in the core), `.env.example`, a README, and a `package.json` with its own direct dependencies (`arch-map` as a `file:`
link, `typescript`, `@types/node`). With a `package.json` the dir is its own package scope, so `arch-map/…` resolves through its
`node_modules/arch-map` link (`npm i` there). **No project code finds anything from its position**: no `..` walk to the core
or to a repo root; a project file reads its own files from `import.meta.url`. The paths the specs record (`source.config`,
`source.file`, `repos.*.url`) are strings built from the config's `HOME`, separate from disk paths, so the folder can be
renamed or moved without changing a byte of its specs.

**The import surface** (`package.json` `name: arch-map` + `exports`; no build step — Node type stripping and Vite read the
`.ts`):

| Import | File | For |
|---|---|---|
| `arch-map/stacks/nest`, `…/supabase` | `scripts/stacks/<s>/index.ts` | the stack entry points a generator, snapshot script or stack test calls |
| `arch-map/generator` | `scripts/lib/generator.ts` | `writeSpec`, `serializeSpec`, `validate`, `formatError`, `SpecInvalidError`, `SCHEMA_REF`, `specsDirOf` |
| `arch-map/testing` | `scripts/lib/testing.ts` | tests: `checkSpecSet`, `documentPaths`, `loadProjects`, `allDocumentPaths`, `projectsDir` |
| `arch-map/cli/check-specs`, `arch-map/cli/check-boundary` | `scripts/check-{specs,boundary}.ts` | tests that run a check as a process |
| `arch-map/core` | `viewer/src/core/index.ts` | tests: merge, Path, queries, tiers, scenario resolution |
| `arch-map/viewer/{model,spec-adapter,layout,scenario,envelopes}` | `viewer/src/<m>.ts` | tests over a project's specs (the viewer's model); not for project code |
| `arch-map/types/<file>` (`arch-map/types/spec` = `spec.d.ts`) | `types/<file>.ts` | types |
| `arch-map/tsconfig.json` | `tsconfig.json` | `extends` of the projects dir's tsconfig |

Anything else is internal; `check:arch` keeps project code to this list. A new export is an API decision: add it to `exports`,
the barrel, the `PUBLIC_API` pattern of `.dependency-cruiser.cjs` and this table together.

**Tooling in force for every project.** `npm test` runs the core's `test/*.test.ts` (on fixtures — `test/fixtures/projects/` is
a fixture projects directory; they pass with no projects) and the active projects' `<p>/test/*.test.ts`; `check:arch` cruises
the projects dir; `check:neutral` reads its manifests (and `neutral-terms.json`); `check:tsc` runs its `tsconfig.json`; the
browser checks open its projects and are skipped without any. Paths in `project.json` (`generate.script`, `snapshots.*.script`,
`determinism.guard`) are relative to the project folder; `documents`, `open` and `determinism.outputs` are relative to its
`specs/`.

- **`CONFIG_SOURCE`:** every project config exports `export const CONFIG_SOURCE = '<repo-relative path of the config file>';`.
  A `declared` element or edge gets `source: { config: `${config.CONFIG_SOURCE}#<export path>` }`. Stack code takes the config
  it is handed and builds that string from `config.CONFIG_SOURCE`; it never spells a project path or name.
- **`DOC`:** a config that has one document exports `DOC = { id, title }` and the builder writes them.
- **Snapshot paths:** a config whose generator reads committed snapshots exports their folder (`SOURCES = `${HOME}/sources``).
  The generator and the snapshot scripts find the files on disk from their own folder (`join(here, relative(HOME, p))`); the
  stack code writes the path into `source.file` / `repos.*.url` as handed, never as a literal. Snapshot scripts that import
  the project config are project entry points; the work itself is stack code (`takeDbSnapshot` in
  `scripts/stacks/supabase/snapshot.ts`).
- **Stack config interfaces:** what a stack reads of a project config is an interface in `types/stacks/<stack>.ts`
  (`NestConfig`, `SupabaseConfig` with `SupabaseEdgeConfig` and `ReactClientConfig`). Stack code types its `config` parameter with it, never with `typeof` a project config. Each
  `<p>/config.ts` ends with the contract `export type StackConfig = Satisfies<NestConfig, typeof import('./config.ts')>;`
  (`Satisfies` from `types/generator.ts`): `tsc` fails there when an export is missing or has the wrong shape; Node strips it.
  A config may export more than its stack reads (the project's `generate.ts` reads it too).

## Neutrality guard (`check:neutral`)

The generic core names no concrete project. `scripts/check-neutral.ts` reads every `project.json` of the active projects dir
and its optional `neutral-terms.json`, and fails when `scripts/` (stacks included), `viewer/src/`, `types/`, the top-level
`test/*.ts`, `specs/schema/`, the root configs (`package.json`, `tsconfig*.json`, `eslint.config.js`,
`.dependency-cruiser.cjs`) or the core docs (`AGENTS.md`, `specs/README.md`, `.env.example`) contain, comments included:

- a project **name** (whole word, case-insensitive; `-` and `_` join words, so `my-<name>` is not a hit);
- an **env var name** from `env` (exact, whole word);
- an **id prefix** from `idPrefixes`, only as an id root (`<prefix>.<segment>`) and not as a call (`<prefix>.<name>(`), because a
  prefix may also be an ordinary word;
- in `viewer/src/` only, a **facet key** used or declared by any project's spec documents (element and edge `facets`,
  `glyphs[].facet`; whole word, not a call). `scripts/stacks/` emit facets and may name them.

There is no allow-list. With no projects and no extra terms there is nothing to forbid: the check says so and passes. The guard
itself names no project (it is data-driven); its unit test (`test/check-neutral.test.ts`) uses a synthetic project and the
fixture projects dir. Not scanned: the projects dir, `docs/`, `README.md`, `test/fixtures/`, `test/browser/`. A project whose
name or prefix is an ordinary word the core needs makes the rule wrong, not the code: rename the project or tighten the rule.
When the guard fires, rephrase the comment generically or move the value into the project config.

## Glyphs are stack data

`viewer/src/spec-adapter.ts` once held a table of one stack's facet keys, so a new stack had to edit the generic viewer to get
its glyphs. Now the mapping is data in the spec document, owned by the stack that emits the facets (AD-13): schema 1.3 adds an
optional document-level `glyphs: [{ facet, shape, role }]` (`shape` is an enum of the viewer's glyphs, so a typo fails
`npm run check`). `core/merge.ts` keeps one ordered list for the set; `shapeOf(el, glyphs)` takes the first declaration whose
facet the element carries, else the core type fallback (`TYPE_SHAPE`, generic, stays in the adapter). The Nest stack declares
its list in `scripts/stacks/nest/glyphs.ts` and its generator emits it; the Supabase stack declares none. A hand
overlay may declare `glyphs` too. `check:neutral` fails on any facet key of the specs in `viewer/src/`. Unit test:
`test/glyphs.test.ts`.

Alternatives not taken: a stack manifest the viewer loads (a second input to the viewer, and a spec document no longer
self-describing); a glyph on each element (repeats one value on hundreds of elements, and the rule is per stack); a glyph inside
the facet value (facet values are free objects shown by the panel); keeping the table (every new stack edits generic code).

Open: the static legend (`viewer/src/bars.ts#renderLegend`) still lists role words of one stack; deriving it from the set's
`glyphs` would change the UI.
