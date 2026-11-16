# 09 — Browser checks (`npm run test:browser`)

These checks exercise real pointer, wheel and CDP pinch input in headless Chromium. They cover selection and hover
cards, re-picking after camera movement, wheel notch bands, pinch limits, search and Path, scenario cinema, project
navigation, offline loading and `?nofacets=1`. All targets are the committed synthetic demos: no external checkout, database or account is needed. They are separate from `npm test` and `check:all` because they
need Chromium and take several minutes.

## Run

```bash
npm ci
npx playwright-core install chromium    # once, revision 1248 for playwright-core 1.64.1
npm run test:browser                    # dev server on a free port; all public-demo checks
npm run test:browser -- pinch wheel     # selected files
npm run test:browser -- --build         # all checks against the built, offline viewer
npm run test:browser -- --build offline # the offline check against the build
ARCH_MAP_MEASURE=/tmp/map.jsonl npm run test:browser
ARCH_MAP_URL=http://localhost:4848 npm run test:browser
```

Leave `ARCH_MAP_PROJECTS` unset for a public checkout. If `.env.local` selects another directory, explicitly use
`ARCH_MAP_PROJECTS=examples`. The browser assertions expect these three public maps. The runner publishes specs,
starts Vite or builds and starts preview, runs one test file at a time, then stops the server. `ARCH_MAP_URL` instead
uses an existing server. Browsers are always headless; there is no headed-window option.

`test/browser/lib.ts` launches pinned Chromium with ANGLE Metal on macOS and viewport **1600 × 1000**. Every check
collects console errors and page errors and asserts zero. One mouse notch is `wheel(0, ∓100)` every **260 ms**.
The pointer aims at the deepest placed ancestor of the target. If its centre is offscreen but part of its block is
visible, the helper uses an actual pickable point in the visible rectangle. Type checking uses
`test/browser/tsconfig.json` (Node and DOM); `npm run check:tsc` includes it.

The site mounts the map into `#app` (`viewer/src/site.ts`, `docs/embedding.md`): its elements are in that element's
open shadow root. Playwright's locators (`page.locator('#q')`, `page.click('#legend summary')`) pierce it; DOM probes
inside `page.evaluate` use `mapRoot()` — the map's shadow root, defined in every page by `withMapRoot(page)` (`open()`
calls it) — where they used `document` (`mapRoot().querySelector`, `.activeElement`, `.elementFromPoint`).

## Public fixtures

- `tasks-supabase` is the default: the client and platform systems, eight tables grouped in one task cluster,
  platform services, two Edge Functions and a five-step summary scenario with two envelopes. Grouping the eight
  tables together gives the pointer checks real neighbours without expanding the synthetic database.
- `library-nest` exercises a genuine three-level module hierarchy. The loan folder contains both a circulation
  module and a small loan-audit module; the audit subscriber writes a notice for a loan event. With only one module
  in that folder the viewer folds that level into its parent, so it cannot serve as a deep zoom regression target.
- `library-nest` also provides the second database for the pointer checks (its loan table and the tables around it).

## Measurements and bands

The numbers below were remeasured on the public demos in headless Chromium 1248 on macOS with ANGLE Metal.
Every calibrated band uses three runs, the observed range and one notch/item of margin. Measurement JSON lines
contain the target, total and per-level counts; failures include those counts. The setup and target ids are part
of the measurement: changing the map, view, viewport or pacing requires a new calibration.

### Wheel notches (`wheel.test.ts`)

| Target from resting view | Observed total | Per level | Band |
| --- | --- | --- | --- |
| Task platform `tasks.system.platform` | 4 | 4 | 3–5 |
| Task Edge Functions `tasks.edge` | 16–17 | 4, 12–13 | 15–18 |
| Task database `tasks.db` | 15–16 | 4, 11–12 | 14–17 |
| Task table cluster `tasks.db.task` | 21–22 | 4, 11–12, 6 | 21–24 |
| Workspace interface `tasks.system.client` | 3 | 3 | 2–4 |
| Library API `library.api` | 4 | 4 | 3–5 |
| Loan module `library.api.loans.loan_module` | 18–19 | 4, 8, 6–7 | 17–20 |
| Out: task table cluster → resting view | 16 | 5–6 each | 15–17 |
| Out: loan module → resting view | 16 | 5–6 each | 14–17 |
| Out after a search (`setFocus` on the loan module) | 20 | — | reaches the overview |

The outgoing guard requires **at least four notches per level** (`OUT_MIN`): the observed minimum is five,
with one notch of margin to catch a cascading exit. Every case must also reach its target.

Where the overview lands (`HOME_BAND`): the camera distance after the last level out over the resting view's,
**0.98–1.0** observed, band 0.9–1.1. Before the zoom-out review (2026-11-08) a parent's way out was measured where
it became the focus, so each level began ~1.8× farther than the last: 1.5–3.1 on the demos, 3.8 on a 3-level real
map (the map a speck). Out after a search: **0** notches with the camera at its farthest distance (band 0–1; before: 4
of 14, overview at 6.3×). The rules: `zoomOut` in `viewer/src/focus.ts` (a parent gone up to is measured as if
framed, a speck parent is framed, the overview comes at the resting distance and lands on it).

Two-finger pan (`wheel(30, 0)` ×6 and a vertical tail `wheel(0, 8)`) moves the target **20.2 units**, changes camera
distance by **0.000**, and leaves focus unchanged. A subsequent mouse notch shortens the distance from **191.3**
to **169.1–169.2**. Assertions remain moved >5, |Δdistance| <0.5, unchanged focus, and a later notch zooming in.

### Search, selection and rendering

| Measurement | Observed | Band/assertion |
| --- | --- | --- |
| Search `tasks` | 14 results | 13–15 |
| Search `/task-summary` | 3 results | 2–4 |
| `POST /task-summary` Path | 8 steps, 1 caller | 7–9 steps; 1 caller |
| Comments selection | 14 lit blocks, 5 lit relations | 13–15 blocks; 4–6 relations |
| Rendering under wheel input | 59.4–59.5 fps | ≥30 fps |

The pinch sequence is **i1 i1 i1 i0 i0 i0 · o1 o1 o1 o0 … o0**: six total level changes, maximum one per series,
zero skips. `i` and `o` mean inward and outward; the digit is the number of focus changes in that gesture.


## Pointer and hover

`click.test.ts` approaches `tasks.db.task.comments` (focused parent `tasks.db.task`) and `library.db.loans`
(parent `library.db`) from up-left, left, below and right. All eight centre clicks must hover and select the target;
the card must not intercept the pointer. The task comments card reports its callers and calls; clicking lights its
neighbours and relations. Its button must remain reachable from all four approaches and select the table.

`hover.test.ts` approaches those targets from the nearest pickable neighbours on each side, moving in three and
twelve steps. The target must own the resting hover and click, and a neighbour card must not cover its middle
when a free side is available. The fixtures exercise neighbours of a task table and of the library's loan
table.

The camera-motion check uses a real **horizontal `wheel(60, 0)` pan** over task-table edges while the pointer stays
still. It requires at least one different block under that pointer, unchanged focus and a hover matching the final
pick after the camera rests. It checks three transitions on the calibrated fixture. A cursor-anchored zoom on this
small map keeps the same block under the pointer, so it does not exercise this invariant; zoom remains covered by
the notch and pinch tests. The pan setup preserves the regression assertion rather than accepting zero transitions.

## Names, the first panel and the status line

`labels.test.ts` opens every project of the manifest at rest and, for every named block (not a plate), moves the
real pointer to a point of its tile that picks to it, then to its name: both must give that block's hover and card;
empty space after each block must hide the card. A second pass goes straight from name to name (a name under the
open card is reached from empty space: a pointer arriving on the card keeps it). A real click on a named tile must
keep the other names (some `.unlit`). Demos: tasks 3, library 5 named blocks, 0 wrong hovers.

`help.test.ts` checks at **1440 × 900** that the main scenario's button in the first panel is above the fold, in the
client and the technical view (tasks: 175–215 px), and that `?` (and the header's «?» button, a click outside) opens
and closes the sheet at rest, with a selection, inside a block, with a scenario open and in the cinema, the closing
Esc changing nothing else; `?` typed into the search box stays text. The Scenarios menu says "Space cinema".

`keyboard.test.ts` (P1-2) goes keyboard only, in every project of the manifest: Tab reaches the map (8 presses), the
arrows select its blocks with the ring on each and `#sr-status` saying «<title>, <kind>[, N parts][, N endpoints], k of
n»; Enter goes into the first block with parts («Inside <title>»), the arrows select a block inside it, Tab goes on to
the panel showing it, Esc returns the keyboard to the map and selects the block you are in, Esc again «Back to the
overview». Enter on a block without parts focuses the panel's title; Shift + ← pans (tasks: the target moves 6.3
units) while a plain arrow does not; Tab from the map lands in the panel at rest, selected and inside a block.

`status.test.ts` checks that the status line holds no renderer counters (they are on `archMap.stats`), that a legend
kind turned off with a real click makes "N relations hidden by filters" appear (tasks: REST, 3) and go when turned
back on, and that one wheel notch out removes a "Zooming toward …" hint within 40 ms.

`polish.test.ts` (needs a project with a scenario: the demo `tasks-supabase`) checks, with real viewport sizes: the
scenario panel scrolls the current step into view on every step change and after leaving the cinema (1440×360, the
step list does not fit); the step bar leaves the legend alone, closed or open (1440×900); at 390×844 the header is at
most 110 px (tasks: 88) with search, project, Scenarios, View and «?» on screen and the step caption not clipped; no
text of the panel or controls is under 11 px; the layer names read at 4.5:1 or more (95th-percentile backdrop pixel;
tasks: 8.2:1); one «Leave ↑»; the project switcher shows the short name; the legend says "off by default".

## Search, Path, scenario and cinema

`smoke.test.ts` searches `tasks`, then `/task-summary`, and presses Enter to open `POST /task-summary` from the
search box. It checks the calibrated result and Path bands and the Path focus bar. Rendering under alternating
wheel input for three seconds must stay at **30 fps or more**.

The `tasks.scenario.summary` scenario must resolve all five nonempty captions with the correct step numbers.
Cinema must enter its title phase, play `step:1` through `step:5`, and exit. It uses the same controls and debug
probes as the earlier regression tests; the scenario contains five public steps.

`cinema.test.ts` runs the task summary uninterrupted using Watch and the real controls, recording executed
visible hops. It asserts every authored step, forward and reverse gateway travel, a frozen camera and elapsed
cursor during response pause, repeated resume without replay, seeking and exit cancellation. A narrow-screen
reduced-motion pass manually starts playback and verifies semantic progress without camera flights. Pure
`test/cinema-flow.test.ts` fixtures cover nested processing, save before the outer return, final unwinding,
authored reverse steps without duplicates, topic-specific subscriber branches, disconnected actions and
channels that must not auto-return. Runtime probes expose the current semantic leg, visible hop, elapsed
cursor and curve direction/progress; no playback clock is accelerated by these checks. Request/response card
schemas and envelope keys must agree with the active leg; unspecified payloads are disclosed. Event checks include
a collapsed publisher with a visible subscriber in another app. A paused framing flight must finish on resume;
a real double-click expansion followed by wheel zoom must resume the same semantic request on its current route.

## Pinch replay

`pinch.test.ts` replays the same fixed seed 12345: twenty series of 25–60 CDP `mouseWheel` events at 60 Hz with
`modifiers: 2` (ctrlKey, no Control keydown), bell-shaped deltaY, six series in and fourteen out. It aims at
`library.api.loans.loan_module`, reaches that module, then returns to the resting view. Every series must move
**at most one level**, both in and out. The fixture has three navigable levels; no skipped level is permitted.

`safari-pinch.test.ts` is the same walk as Safari sends it: WebKit `gesturestart` / `gesturechange` / `gestureend`
with a cumulative `scale` (no ctrlKey wheel), built in the page and dispatched at the element under the point, twenty
series of 25–60 events at 60 Hz, scale eased from 1 to 1.6–3.0 (in) or to its inverse (out). Same assertions; observed
six level changes, at most one per series (**i1 i1 i1 i0 i0 i0 · o0 o1 o1 o1 o0 … o0**; the first in-series may
land one later between runs). Playwright cannot make a real WebKit gesture, so a
pinch on a real trackpad in Safari is still worth a look after changing `gesturePinch` (input.ts) or its wiring.

## Projects, facets and offline behavior

`projects.test.ts` verifies the default task map, every switcher option, distinct models, clean project
navigation, Back query and hash restoration, a Path deep link into the library backend, legacy `?docs=` links,
selection hashes, phone-width layout and a single-project manifest hiding the switcher.

`nofacets.test.ts` compares the task summary Path and library loan creation Path with and without `?nofacets=1`.
The normal model must carry facets, the stripped model must carry zero element/edge facets, and both Path results
must be identical. The task model has 28 faceted nodes and one faceted edge; the library has 35 and 20, respectively. Their Paths retain eight and seven steps. This is the browser half of `check:boundary`.

`offline.test.ts` aborts every request outside localhost/127.0.0.1. It asserts zero blocked/failed requests, at least
three loaded bundled IBM Plex faces, placed blocks, a working summary Path from search, and zero errors. Run it
against both the dev server and `--build` preview. The verified runs made 74 dev requests and 15 preview requests, with seven fonts, three resting blocks and an eight-step summary Path in each; blocked requests, failed requests and errors were all zero.

## The package on a host page

`embed.test.ts` builds the package (`scripts/build-lib.ts`) and serves `test/browser/embed.html`, the package's
`dist/` and the published specs from a server of its own, so every request is seen; it does not use the viewer's
server. Two maps (the default demo project by URL in the dark look, the next one as objects in the light look) take
real wheel notches, clicks, Esc and `?` each without the other moving; the host page's styles, `<html>`, hash, history
and title stay as they were, and nothing outside `dist/` and `specs/` is fetched. Destroy and mount ten times: one
WebGL context alive, none after the last destroy, the CDP listener lists of window and document back to the page's
own, no animation frame after destroy, an empty shadow root. A spec with schema 2.x and a missing URL show the notice
in their element and call `onError`; a 0×0 container is drawn once sized. `<arch-map>` is loaded from the ES modules
with three from an import map. It runs the same with and without `--build`.

## Three upgrades and band failures

The pinch limiter uses `MapControls` internals from three 0.186.1 (`viewer/src/scene-controls.ts`, AD-15). After a
three upgrade or input-handling change, run `npm run test:browser -- pinch wheel`: every pinch series must still
move at most one level and notch counts must stay in their bands.

When a band fails, inspect its `levels` diagnostic and confirm whether the fixture or layout changed. Do not widen
it to hide a regression. For a deliberate change, collect three or more runs with `ARCH_MAP_MEASURE`, use the new
observed range plus a notch of margin, and update this document and the test together.
