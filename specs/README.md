# specs/ — the architecture as data

JSON documents that describe a codebase's architecture: what exists, how parts call each other, what goes
over each edge. The 3D map is drawn from them; an agent can read them directly. Everything needed to
answer "who calls X / who writes Y" is here — the viewer source is not needed.

The ids in the examples below (`shop.api.orders…`) are illustrative: they show the id shapes. Real ones are in the
example projects under `examples/`, each with its own `specs/` folder.

## Files: a folder per project

The spec documents live with their project: a projects directory (env `ARCH_MAP_PROJECTS`; default `examples/` of
this repo) holds `index.json` (the switcher order and the default project) and one folder per project,
`<projects dir>/<project>/`, with `project.json` (schema [`schema/project.schema.json`](schema/project.schema.json)),
its code and, in `specs/`, its documents, its `contracts/`, an optional README for what is particular to it, and the generators'
reports (`*.unresolved.json`; `*.meta.json` is gitignored). This folder (`specs/` of arch-map) holds only what every
project shares: the format, [`schema/spec.schema.json`](schema/spec.schema.json) (`npm run check` validates against
it), and this README. Which documents form a project, in load order, and which of them the map opens with, is in its
`project.json` (`documents`, `open`); the map opens `index.json#default`, another project with `?project=<name>`, any
subset with `?docs=a.json,b.json`. Every document's `$schema` is `../schema/spec.schema.json`: the schema as the
viewer's published copy lays it out (`viewer/public/specs/<project>/<doc>` next to `schema/`), wherever the project lives.

A project is checked as a set of its own: ids are unique and `requires` resolve inside it; contracts (`contract.doc`,
envelope keys `contracts/…#/…`) are relative to the document, so to the project's `specs/contracts/`. Document names
are unique across projects; an element id in two projects is a warning.

Every document: `{ schemaVersion, id, title, requires?, repos?, tiers?, glyphs?, elements[], edges[], scenarios?, envelopes?, overrides? }`.
A hand overlay's systems claim apps and datastores (`contains`): after merging, `shop.api`'s parent is
`overlay.sys.backend`; in the file itself every app/datastore has `parent: null`.

## Elements

| Field | Meaning |
|---|---|
| `id` | stable dotted id, e.g. `shop.api.orders.order_module.order_service` |
| `type` | `actor system app module component endpoint datastore table external-system job queue bus` |
| `parent` | single parent id (`null` for roots; apps/datastores get theirs from a system's `contains`) |
| `name`, `description`, `technology` | display text (`technology` is a label only) |
| `tier` | apps: one of the tiers (default `ui` / `service` / `data`); everything else inherits it (see Tiers) |
| `provenance` | `extracted` (from code), `declared` (from the project config, `<project>/config.ts`), `authored` (hand) |
| `source` | `{ repo, file, line }` (URL: fill `repos[repo].blob`) or `{ config: "<path of the config>#…" }` (the project config's `CONFIG_SOURCE`, then `#` and the export path) |
| `context` | `true` = outside the slice, shown only because something in the slice touches it |
| `derivedFrom`, `confidence` | inferred groupings: `{ rule: folder, value }`, `high/medium/low` |
| `methods` | components: `[{ name, line, unresolved? }]` |
| `handler`, `http`, `access`, `contract` | endpoints: serving method, `{ method, path }`, auth, contract |
| `columns` | tables: `[{ name, type, nullable, pk }]` |
| `contains` | systems: claimed app/datastore ids |
| `facets` | optional stack detail, keyed `stack.kind` (`nest.service`, `pg.rls`, …). Never needed to answer a core question |

Endpoints (REST routes, RPCs, webhook targets) are children of the component that serves them. Endpoint id =
`<component id>.<http method>_<path as snake>`.

## Tiers (since 1.1)

The map's horizontal layers, top-down. Default: `people`, `ui`, `service`, `data`. A document may declare its own:

```json
"tiers": [{ "id": "people", "title": "People" }, { "id": "ui", "title": "Interfaces" },
          { "id": "service", "title": "Services" }, { "id": "async", "title": "Background work" },
          { "id": "data", "title": "Data" }]
```

The merged set has one list: documents that declare `tiers` must declare the same one (`npm run check` fails
otherwise; the viewer's `?docs=` subsets keep the first and warn). An element's `tier` must name a tier of the set.
Without one, an element takes its parent's tier, else its type's (`actor` → people, `table`/`datastore`/
`external-system` → data, the rest → service); a `system` stands on the topmost tier of its parts.

## Glyphs (since 1.3)

How the map draws an element that carries a facet: the stack that emits the facet declares it, the viewer names none.

```json
"glyphs": [{ "facet": "nest.controller", "shape": "endpoints", "role": "controller" }, …]
```

`shape` is one of the viewer's glyphs (the schema lists them), `role` the words on the card. The set's list is every
document's in load order; an element with several declared facets takes the first. A facet declared in two documents
must be declared the same way. Without a declaration an element is drawn by its core type. Display only: no core
question depends on it.

## Rails: buses, queues, jobs (since 1.1)

`bus`, `queue` and `job` are cross-cutting, not a layer: the map draws each as a long thin rail along the front edge
of its column, a little below its tier (an in-process bus of the backend runs in front of the backend's board, out of
the way of the lines down to the tables),
never as a column or a block of its own. A rail inside an app is seen once that app is open; while the app is
closed, its rails' relations fold into the app's as any other part's. A rail at the root runs across the whole map.

Edges go through a rail, topic by topic: the topic stands where a method would.

```
publisher#method > bus#Topic :event      (who publishes the topic; `label` = the event's name)
bus#Topic > subscriber#handler :event    (who handles it)
```

So a Path walks from the publisher into the bus and on to that topic's subscribers (the next level); a scenario step
`{ from: publisher, to: subscriber, channel: event }` matches the two edges through the bus as one step.
A document may hold several buses, e.g. an application's domain-event bus (topics = event classes) and a decorator
dispatcher (topics = what it dispatches on). A bus with no edges is still drawn and listed in the generator's
`*.unresolved.json` (`idle-bus`).

```sh
# who handles OrderPaidEvent
jq -r '.edges[] | select(.from == "shop.api.bus.domain_events" and .fromMethod == "OrderPaidEvent") | .to' <projects dir>/<project>/specs/*.json
# who publishes to any bus, with the topic
jq -r '.edges[] | select(.to | contains(".bus.")) | "\(.from)#\(.fromMethod) → \(.to)#\(.toMethod)"' <projects dir>/<project>/specs/*.json
```

## Edges

`{ id, from, to, channel, fromMethod?, toMethod?, via?, label?, ops?, sites?, provenance, source?, access?, contract?, facets? }`.
Edge id = `<from>[#<fromMethod>]><to>[#<toMethod>]:<channel>`. Calls, data access, events and outbound HTTP are
per method (`fromMethod`), so a method's behaviour is the set of edges leaving `component#method`.

| Channel | Meaning | `ops` |
|---|---|---|
| `call` | in-process call (`from === to`: a method calls its own sibling) | — |
| `event` | in-process event: publisher → bus topic, bus topic → subscriber method (see Rails) | — |
| `rest` | HTTP call to an endpoint (front → API, function → RPC) | — |
| `webhook` | an outside system calls an endpoint | — |
| `read` / `write` | data access to a table (separate edges, never "both") | data-access call names |
| `https` / `smtp` | calls to an outside system | client methods |
| `trigger` | a table fires a function (database trigger) | — |
| `schedule` | time-based start | — |
| `import` | front-end module import | — |
| `references` | foreign key, table → table | FK field names |
| `interacts` | client layer: actor → system | — |

`via` (since 1.2) = the elements a relation physically passes through, in order: an Edge Function's
`.from('job').select()` is the relation `function → job :read` with `via: ["<app>.gateway", "<app>.rest"]` — the
client library calls the gateway, the REST layer runs the SQL. Core questions (who reads `job`) use `from`/`to` and ignore `via`; the map
draws the relation along it, hops shared by many relations bundled into one line.

`access` = `{ level: public|authenticated|restricted, roles?, guards?, policies? }`; on an edge without its own,
the target endpoint's applies. Non-empty `policies` = row-level security on that read/write (map: a lock).
`sites` = every call site `{ repo, file, line }` folded into one edge.

## Contracts

`contract = { doc, operationId?, request?, response? }`; pointers are local to `doc`:
`{ "doc": "contracts/backend.openapi.json", "request": "#/components/schemas/CreateOrderDto" }`.
The edge's effective contract is its own, else its target endpoint's. Resolve with
`jq '.components.schemas.CreateOrderDto' <projects dir>/<project>/specs/contracts/backend.openapi.json`.
The same `doc + pointer` = the same object wherever it travels.

## Client layer (a hand overlay)

Scenario step: `{ caption, element }` or `{ caption, from, to, channel?, contract? }`, both with an optional
`duration` (seconds the step stays on screen when the scenario plays itself; default by the caption's length, 5–10 s);
an edge step matches every edge between `from`/`to` **or their descendants** on that channel. `envelopes` are keyed by `doc + pointer`:
`{ title: "Order", fields: { start_id: "Start", … } }` — client-friendly names of real schema properties.
`overrides` change only the display `name`/`description` of another document's element.

## Questions with jq

A project's documents at once: `<projects dir>/<project>/specs/*.json` (`*.unresolved.json` holds no `edges`, so
adding it changes nothing); several projects together just list more files. Each project's README (in its `specs/`)
has these written on its own ids.

```sh
# find an element by name
jq -r '.elements[] | select(.name | test("^OrderService$"; "i")) | .id' <docs>
# who writes table shop.db.orders
jq -r '.edges[] | select(.channel == "write" and .to == "shop.db.orders") | .from' <docs> | sort -u
# who calls OrderService.pay (caller component#method)
jq -r '.edges[] | select(.to == "shop.api.orders.order_module.order_service" and .toMethod == "pay")
       | .from + "#" + (.fromMethod // "")' <docs> | sort -u
# who calls anything inside a component (its endpoints included: ids are prefixes)
jq -r --arg x shop.api.orders.order_module.order_controller '.edges[]
       | select((.to == $x or (.to | startswith($x + "."))) and (.from | startswith($x) | not)) | "\(.channel) \(.from)"' <docs> | sort -u
# what one method does (one Path level; follow call/event/schedule toMethod for the next)
jq -r '.edges[] | select(.from == "shop.api.orders.order_module.order_service" and .fromMethod == "pay")
       | "\(.channel) \(.to)#\(.toMethod // "")"' <docs>
# tables behind row-level security
jq -r '.edges[] | select(.access.policies) | "\(.from) -\(.channel)-> \(.to): \(.access.policies | join(", "))"' <docs>
```

The same answers in code: `viewer/src/core/queries.ts` (`writers`, `readers`, `callers`, `summary`),
`core/path.ts` (`trace`, `traceEndpoint`), `core/resolve.ts` (contracts, access, scenario steps). Facets can be
removed entirely and every answer stays the same (`npm run check:boundary`).

## Path

A Path is what happens when a method runs: numbered steps, depth first, over core edges (`core/path.ts` `trace`;
`traceEndpoint` starts at an endpoint's handler; deep link `#p=<component>|<method>`). From `<component>#<method>`:

- each edge leaving it (`fromMethod`) is a step, in channel order `call, read, write, event, rest, webhook, https,
  smtp, trigger, schedule`;
- **the next level** is entered by `call` / `event` / `trigger` with a `toMethod` (into `to#toMethod`), by `rest` /
  `webhook` to an endpoint (into its component's `handler`), and by `schedule` either way (`toMethod`, or an endpoint's
  handler). A schedule runs later, but it is what the method sets going: a pg_cron job → Edge Function or SQL function;
- `read`, `https`, `smtp` are leaves; a `write` to a table is followed by the `trigger` edges leaving that table;
- a call to the component's own method (`from === to`, `call`) is not a step: the walk stays on the level;
- each `unresolved[]` entry of a method is a `break` step;
- **cycles:** a method is walked once per Path. A step into a method walked earlier in the Path is a leaf; a step into
  one still being walked (an ancestor: recursion — a workflow that schedules itself, a trigger whose function writes
  its own table again, a drain that calls its own route) is a leaf with `cycle: true`, shown as «↻ cycle»;
- limits: 500 steps (`MAX_STEPS`), depth 9.

A job rail (`type: job`, e.g. a database's cron, `<app>.pg.pg_cron`) has no methods: each job is the `fromMethod` of its `schedule` edges,
so `#p=<app>.pg.pg_cron|<job name>` is the Path of one job — its time-based start, with the scheduled function as the
next level. Who invokes something (`callers`) counts `schedule` like `call` / `rest`: the job, or the workflow that
schedules, is a caller of what it schedules.
