# Adding a stack

A **stack** teaches arch-map one kind of system: how to scan it and turn what it finds into spec documents. The two that
ship are `scripts/stacks/nest/` (NestJS backends and their frontends) and `scripts/stacks/supabase/` (Postgres from a
snapshot, Edge Functions, a React + supabase-js client). The viewer never changes for a new stack: it draws core types and channels (AD-3, AD-4), and what is
stack-specific travels in facets and glyphs.

## What a stack is

- A folder `scripts/stacks/<stack>/` with an **entry point** `index.ts` that exports what a project's generator, snapshot
  scripts and tests call. Everything else in the folder is internal; `check:arch` keeps project code to the entry point.
- A **config interface** in `types/stacks/<stack>.ts`: everything the stack needs from a project (the id root, document
  title, which folders to scan, outside systems, method names that read data, …). Stack code takes a `config` parameter typed
  with it and **never names a project, an id root or a value itself**: every id and value comes from the config it is handed.
  A project's `config.ts` proves it fits with `export type StackConfig = Satisfies<YourConfig, typeof import('./config.ts')>`.
- An entry in `package.json` `exports` (`"./stacks/<stack>": "./scripts/stacks/<stack>/index.ts"`).
- Import rules in `.dependency-cruiser.cjs`: a stack imports only itself, `scripts/lib/`, `viewer/src/core/` and `types/`
  (`stack-<stack>-imports`, modeled on `stack-nest-isolated`). Add yours next to the others; add the entry point to the
  `PUBLIC_API` pattern.

## The pieces

1. **Scan.** Read the target codebase (read only, always) into an intermediate model. Put its shapes in `types/stacks/<stack>.ts`
   (anything another file consumes lives in `types/`, not in JSDoc). If the system cannot be read from code — a live
   database, a no-code export — write a **snapshot** function instead: it reads the live source once, redacts secret-like strings,
   keeps structure and never data, and returns a JSON shape that the project commits under its `sources/`. The generator then reads the
   committed snapshot, never the live system. A snapshot function is called by a small script in the project
   (`snapshots` in `project.json`); the work itself is stack code, so every project of the stack shares it.
2. **Build.** Turn the model into an `ArchMapSpecDocument` (`types/spec.d.ts`) with `provenance` and `source` on every item
   (AD-5): `extracted` items carry a code location; items that come from the config are `declared` with
   `source: { config: `${config.CONFIG_SOURCE}#<export>` }`. Follow the core rules:
   - Element types and channels come from the core sets (AD-3, AD-4). Calls, data access, events and outbound HTTP are edges
     per method (`fromMethod`), so Path works without any facet.
   - Ids are stable and snake-cased (AD-6); endpoints are children of the component that serves them.
   - Stack detail goes into `facets` keyed `stack.kind` (`nest.service`, `pg.rls`, …); nothing in the core may depend on it.
   - Declare how the map draws your facets with `glyphs` (AD-13): `[{ facet, shape, role }]`, shapes from the schema's enum.
     See `scripts/stacks/nest/glyphs.ts`. Without a declaration an element is drawn by its core type.
   - Row-level policies go into `access.policies` on the `read`/`write` edge (AD-9); a relation that physically travels
     through other elements says so with `via`.
   - Put on the map only what is certain. What the scanner could not resolve goes into a `*.unresolved.json` report with a
     reason and a location, never onto the map as a guess.
3. **Entry point.** Export the scan/snapshot/build functions and any helper a project's tests need.
4. **Tests.** Unit-test the pure parts on small invented inputs (`test/` of the core for shared parts, or the example project's
   `test/`). The builder should be pure: model in, document out.
5. **An example.** Add a small invented project under `examples/` that uses the stack (see `docs/adding-a-project.md`), so the
   stack is exercised by `npm test` and `check:boundary` and a reader can open its map.

## Rules that the checks enforce

- `npm run check:arch` — import layers (see `docs/code-quality.md`); stacks do not import each other (the one exception is
  named in the rules).
- `npm run check:neutral` — the generic core, stacks included, names no project: no project name, env var or id root of any
  project's manifest. A stack may name the **facet keys it emits**; the viewer may not.
- `npm run check` and `check:boundary` — the documents validate, merge, and answer the same core questions without facets.
- `npm run check:determinism` — two runs write byte-identical files and leave the target unchanged. Use `writeSpec` from
  `arch-map/generator`; do not write timestamps into specs (time and counts go into `*.meta.json`).
- `npm run check:tsc` — a stack config interface that a project config does not satisfy fails at the project's `config.ts`.

## A checklist

- [ ] `scripts/stacks/<stack>/index.ts` and the modules behind it, with no project literal in them
- [ ] `types/stacks/<stack>.ts` with the config interface and the shapes shared across modules
- [ ] `package.json` `exports` and the dependency-cruiser rules and `PUBLIC_API` pattern
- [ ] `glyphs` for the stack's facets
- [ ] an unresolved report for anything uncertain
- [ ] an invented example project and tests
- [ ] `npm run check:all` green
