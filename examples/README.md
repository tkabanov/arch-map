# Synthetic architecture demos

These two invented codebases exercise the NestJS and Supabase adapters. They contain no application rows, private exports, credentials or external checkout dependencies. The target sources are small scanner fixtures, not deployed applications: generating architecture needs only this repository's installed dependencies and Node 22.18 or later. No framework packages or database servers need to run.

Each folder owns `project.json`, `config.ts`, `generate.ts`, local generator helpers, `snapshot.ts`, `target/`, committed `specs/` and `test/`. Configs import the stack adapters directly. Generators locate targets relative to their own files, ignore environment roots, read targets without modifying them, and use content hashes rather than the parent checkout's commit for reproducible provenance.

```sh
npm ci
npm run gen -- tasks-supabase        # or library-nest
npm run check
npm test                            # core tests and all demo oracles
npm run check:determinism            # two runs; contracts, diagnostics and recursive target guards
npm run check:all
npm run viewer                      # http://localhost:4848
npm run viewer:build
npm run test:browser                 # headless Chromium, both public maps
```

Leave `ARCH_MAP_PROJECTS` unset to select these demos. There is deliberately no `examples/package.json`: Node resolves `arch-map/...` through the root package's self-reference, and one root `npm ci` supplies every tooling dependency. `examples/tsconfig.json` extends `arch-map/tsconfig.json`; the standard type check includes it. No separate install, runner or publisher is needed. The default map is the task platform with its client overlay and scenario. Select the other map in the viewer or use `?project=library-nest`.

| Demo | Target contents | Generated map |
| --- | --- | --- |
| `library-nest` | Seven feature areas with eight Nest modules (including loan auditing), six Sequelize models, twelve REST routes, circulation events, an email adapter, a catalog exchange, a Vue catalog page and hand-authored OpenAPI | 56 elements; 38 edges across call, event, HTTPS, import, read, reference, REST, SMTP, webhook and write channels |
| `tasks-supabase` | Eight public tables, nine foreign keys, four SQL functions, a trigger, nine RLS policies, a cron task, a private bucket, two Edge Functions and a React client | 50 elements; 70 edges; a five-step summary scenario; two envelopes |

`tasks-supabase` adds platform-owned storage metadata tables and its bucket to the eight authored tables (eleven table elements in total). Its `tasks-client.json` is a hand-written overlay: two systems claim the client and platform roots, a scenario follows a summary request, and envelopes explain the request and response fields. The Edge Functions exercise attachment reads and writes. The React scanner currently maps table access, RPCs, authentication and Edge Function calls; storage effects are demonstrated on the Edge side.

Snapshots are authored inputs, not captures from live services. `npm run snapshot -- <name>` copies the library's local OpenAPI contract, or canonicalizes the task catalog after editing it. It does not connect to a database or the network. Run `gen` afterwards. The database catalog deliberately uses the stack snapshot writer's one-space indentation so its line-indexing provenance remains accurate.

The contracts come from the Nest OpenAPI snapshot and the Supabase contract builder. Generated `.unresolved.json` reports are committed and expected to be empty.

The demo oracles assert exact counts by element type and edge channel, representative stable ids, schema/set validity and contracts. Core commands validate manifests, merge references and overlays, and compare two full generations including contracts and diagnostics while checking recursive target guards remain unchanged. `target/` stays outside architecture and tooling TypeScript checks because those files are scanner input in several framework dialects, not arch-map tooling. The task table domains share one cluster so real pointer regression checks have eight neighbouring tables; this changes grouping only, with no larger synthetic codebase.
