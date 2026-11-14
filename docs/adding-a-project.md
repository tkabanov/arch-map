# Adding a project

A **project** is one system arch-map maps: a folder in the projects directory. Adding one changes nothing in the core;
`npm run check:neutral` and `npm run check:arch` prove it. The decisions behind this are AD-16 in `docs/architecture.md`;
the conventions the tooling relies on are in `docs/code-quality.md` ("Project homes"). The examples in `examples/` are
complete projects to copy from: `library-nest` (NestJS) and `tasks-supabase` (Supabase).

## 1. Choose the projects directory

The core reads projects from the directory named by `ARCH_MAP_PROJECTS` (in `.env.local`; absolute, or relative to the
checkout). Unset, it is `examples/` of this repo. A projects directory can be its own repository next to the checkout:

```bash
# in the projects directory: a package of its own, linked to the core checkout
npm init -y && npm pkg set type=module
npm pkg set dependencies.arch-map=file:../arch-map    # the path from here to the core checkout
npm i -D typescript@5.9 @types/node                 # a generator copied from examples/ imports `typescript` itself
npm i
# in the arch-map checkout's .env.local
ARCH_MAP_PROJECTS=/path/to/projects
```

Keep it a `file:` link (a symlink): Node resolves it to the core's real path, outside `node_modules`, so type stripping still
runs the core's `.ts`. A git or registry dependency would install a copy under `node_modules`, where Node refuses to strip
types. Project code imports the core only by package name (`arch-map/stacks/<s>`, `arch-map/generator`, `arch-map/core`,
`arch-map/types/<file>`, …), never by a relative path.

## 2. Make the folder

```
<projects dir>/
  index.json                 { "default": "my-app", "order": ["my-app"] }
  my-app/
    project.json             the manifest (schema: specs/schema/project.schema.json)
    config.ts                what to scan and show; ids and values the stack needs
    generate.ts              calls the stack, writes specs
    sources/                 committed snapshots: structure, no data (if the stack takes snapshots)
    test/                    the project's own tests
    specs/                   documents, contracts/, *.unresolved.json, a README
```

`project.json`:

```json
{
  "name": "my-app",
  "title": "My app — NestJS",
  "documents": ["my-app.json", "my-app-client.json"],
  "open": ["my-app.json", "my-app-client.json"],
  "idPrefixes": ["app"],
  "env": { "MY_APP_ROOT": { "about": "a checkout of my-app (read only)", "mustHave": "package.json" } },
  "generate": { "script": "generate.ts", "needs": ["MY_APP_ROOT"] },
  "determinism": { "roots": ["MY_APP_ROOT"], "outputs": ["my-app.json"] }
}
```

- `documents` is the whole set in load order; `open` is what the map opens with (a subset). Paths are relative to `specs/`.
- `idPrefixes` is the first segment of the project's element ids. No core logic reads it; `check:neutral` uses it.
- `env` lists the variables the project reads. They go into the same `.env.local`. `default` may expand another variable
  (`${OTHER}`); `mustHave` is a path that must exist under the directory the variable names.
- `generate` and `snapshots.<kind>` are scripts relative to the project folder; `needs` names variables that must be set.
- `determinism` says which variables name target checkouts whose git status must not change, and which outputs two runs must
  write byte-identical.

Add the folder to `index.json` (`order`) and name the default project (`default`): an index that lists projects needs one. Zero projects is valid. Document names must be unique across all projects of the directory (`?docs=` finds a project by them), so prefix them with the project: `my-app-client.json`, not `client.json`.

## 3. Write `config.ts` and `generate.ts`

Pick the stack that matches the code (`scripts/stacks/{nest,supabase}/`, or write one: `docs/adding-a-stack.md`). Its
config interface is in `types/stacks/<stack>.ts`; end your config with the contract that makes `tsc` check it:

```ts
import type { Satisfies } from 'arch-map/types/generator';
import type { NestConfig } from 'arch-map/types/stacks/nest';

export const HOME = 'examples/my-app';                  // how the specs name this folder (provenance string, not a disk path)
export const CONFIG_SOURCE = `${HOME}/config.ts`;       // `declared` items point here
export const DOC = { id: 'my-app', title: 'My app — extracted core' };
// … the stack's keys: id root, externals, read/write method names, …
// (Nest: each app's `repoUrl`, and `blobUrl` when source links are not GitHub-style — see types/stacks/nest.ts)
export type StackConfig = Satisfies<NestConfig, typeof import('./config.ts')>;
```

`generate.ts` finds its own files from `import.meta.url`, calls the stack's builder with the config, and writes through
`writeSpec` from `arch-map/generator` (deterministic output, schema-validated, nothing written when invalid):

```ts
import { scanBackend, buildSpec } from 'arch-map/stacks/nest';
import { writeSpec, specsDirOf } from 'arch-map/generator';
```

The generator **only reads** the target codebase. If a stack needs data it cannot read from code (a database schema, a
no-code export), keep a snapshot script in the project (`snapshots` in `project.json`) that writes the structure (no data) into
`sources/`, commit it, and let `generate.ts` read the snapshot, never the live system. A database snapshot keeps definitions too (views, function bodies, cron commands); secret-like strings
are redacted by pattern, which cannot catch every literal, so read the snapshot before you commit it.

## 4. Add the hand layer

What the code cannot tell is a document you write: actors, systems that claim the generated apps and databases (`contains`),
scenarios, envelopes. It `requires` the generated documents. Start from `examples/tasks-supabase/specs/tasks-client.json`. The format is in
`specs/README.md`; "Editing a hand overlay" in the root `README.md` has the rules.

## 5. Generate and check

```bash
npm run gen -- my-app           # runs generate.ts, checks the project's set, copies it for the viewer
npm run check -- my-app         # schema, merge, claims, scenarios, contracts, envelopes: errors as file:line (id)
npm run check:boundary -- my-app   # the same answers without facets
npm run check:determinism -- my-app
npm run viewer                  # http://localhost:4848/?project=my-app
```

What the generator could not resolve is in `specs/<doc>.unresolved.json`; it is never guessed onto the map.

## 6. Tests

Put the project's tests in `my-app/test/*.test.ts`; `npm test` runs them with the core's. They can import the core by
package name (`arch-map/core`, `arch-map/testing`, `arch-map/viewer/model`, …). A useful test pins what the stack should find
(a count of endpoints, a Path) on a small committed fixture, so a regenerated spec that loses something fails.
