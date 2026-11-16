# Embedding the map: `@arch-map/viewer`

The viewer is a browser package as well as a site. `mount(container, options)` renders the whole map — header with
search, Scenarios, View and help, the 3D stage, the panel, the status line — into an **open shadow root** of
`container`, from spec documents given as objects or URLs. It owns nothing outside that element: no global styles, no
`location` or `history` unless asked, no keys outside its element unless asked. `destroy()` removes every listener,
timer, animation frame and the WebGL context and leaves the element empty. Two maps on one page share nothing.

The package lives in `packages/viewer/` (its `package.json` and README); `npm run lib:build` builds it,
`npm run lib:pack` builds it and checks what `npm pack` would publish. It is on npm: [`@arch-map/viewer`](https://www.npmjs.com/package/@arch-map/viewer).
Releases go out from GitHub Actions on a `viewer-v<version>` tag (`.github/workflows/publish-viewer.yml`).

## Install

```bash
npm install @arch-map/viewer
```

- `three` is a **dependency** pinned to the 0.186 line: the trackpad pinch relies on internals of its
  `OrbitControls` (AD-15; a bump needs the pinch browser check, `docs/browser-checks.md`). Not a peer: no three
  object crosses the API and the map writes no shared three state, so an app with another three installs without a
  conflict and gets a private copy for the map (and three's "multiple instances" console warning). The single-script
  build bundles it.
- `react` (≥ 18) is an optional peer, only for `@arch-map/viewer/react`.
- The package's **major version is the spec schema's major** (`SCHEMA_MAJOR`): `@arch-map/viewer@1` reads specs
  `1.x`. The JSON schemas ship in the package: `@arch-map/viewer/schema/spec.schema.json`.

What the package holds:

| Export | File | What |
|---|---|---|
| `@arch-map/viewer` | `dist/index.js` (+ `.d.ts`) | `mount`, `SCHEMA_MAJOR`, the types (`MountOptions`, `ArchMapSpecDocument`, …) |
| `@arch-map/viewer/element` | `dist/element.js` | defines `<arch-map>` (`ArchMapElement`, `defineArchMap(tag)`) |
| `@arch-map/viewer/react` | `dist/react.js` | `<ArchMap … />` |
| `@arch-map/viewer/fonts.css` | `dist/fonts.css` + `dist/fonts/` | the bundled fonts (IBM Plex; Manrope and JetBrains Mono for themes) |
| `@arch-map/viewer/iife` | `dist/arch-map.iife.js` | one classic script, three bundled, the global `ArchMap`: a path for `<script src>` (a bundler's `?url`), not a module — `import()` of it defines no global |
| `@arch-map/viewer/schema/*` | `schema/*.json` | the spec format's JSON schemas |

The render package depends on nothing of this repository's generators (`scripts/`, `typescript`, `libpg-query`, ajv):
the generators stay this repository's tooling; `build-lib.ts` fails when an ES module of the package imports anything
but three and react.

The package's `dist/licenses/` holds the original third-party copyright and license notices: the five bundled font
families under the SIL Open Font License, and `three.txt` under MIT. The standalone IIFE also retains three's MIT
notice in the script. Keep these notices when redistributing the assets; arch-map itself remains MIT licensed.

## Use it

### ES modules

```js
import { mount } from '@arch-map/viewer';
import '@arch-map/viewer/fonts.css';

const map = mount(document.querySelector('#map'), {
    specsUrl: ['/specs/backend.json', '/specs/client.json'],
    theme: 'light',
    onFocus: (id) => console.log('inside', id),
    onSelect: (hit) => console.log('selected', hit),
    onError: (e) => console.warn(e.title, e.lines),
});
await map.ready;
```

The element needs a size: the map fills it (`#map { height: 640px }`). An element with no size yet (hidden, in a
closed tab) is drawn once it gets one.

### A plain page (one script)

From a CDN, pin the major (the spec schema's): `https://unpkg.com/@arch-map/viewer@1/dist/arch-map.iife.js` and
`…@1/dist/fonts.css`. From your own copy:

```html
<link rel="stylesheet" href="/node_modules/@arch-map/viewer/dist/fonts.css">
<div id="map" style="height: 640px"></div>
<script src="/node_modules/@arch-map/viewer/dist/arch-map.iife.js"></script>
<script>
  ArchMap.mount(document.getElementById('map'), { specsUrl: ['specs/a.json', 'specs/b.json'] });
</script>
```

Nothing else goes to the network: the specs, and the contract documents (OpenAPI, JSON Schema) the specs name, when a
panel, a scenario step or an envelope first needs them.

### The custom element

```js
import '@arch-map/viewer/element'; // defines <arch-map>
```
```html
<arch-map src="specs/a.json,specs/b.json" theme="light" style="display: block; height: 640px"></arch-map>
```

`src` (comma-separated URLs) and `theme` are attributes and follow changes; `el.specs = [doc, …]` takes documents as
objects; `el.options = { onSelect, keyboard, … }` is read when the map mounts (set it before the element is
connected; both properties set before the module defined the element are kept); `el.handle` is the mounted map.
Removing the element destroys the map. Import `defineArchMap` from `@arch-map/viewer/element` and call
`defineArchMap('another-map')` to register an additional tag with a fresh subclass. Repeating a tag is a no-op.

### React

```jsx
import { ArchMap } from '@arch-map/viewer/react';

<ArchMap specsUrl={['specs/a.json']} theme="dark" style={{ height: 640 }} onSelect={(hit) => setSelected(hit)} />
```

It mounts once; later `specs` / `specsUrl` / `theme` go to the same map (`setSpecs`, `setTheme`), compared by content
(the complete documents or the URL list; the theme as JSON), so an equal inline array is no
change. Edits to nodes, edges or scenarios are detected even when document ids and schema versions stay unchanged.
StrictMode's replayed effects leave a single live map. The callbacks always call the latest props. Every other
option (`urlState`, `storageKey`, `keyboard`, `debug`, `loadContract`, `contractsBase`, `title`, `name`, `nofacets`) is
mount-only: read once. Unmounting destroys it. `onHandle(handle)` gives the handle (null after unmount).

## Options

| Option | Default | |
|---|---|---|
| `specs` | — | the documents as objects: a document, or `{ name, doc }` with the file name other documents `require` it by (a bare document is named `<id>.json`) |
| `specsUrl` | — | the documents' URLs; their names are the file names |
| `loadContract(name)` | fetch `contractsBase + name` | loads one contract document by the name the specs give it |
| `contractsBase` | the folder of the first URL (else the page's) | |
| `theme` | `'dark'` | `'dark'`, `'light'`, or a project theme `{ base, colors, fonts }` (`types/project.ts` `ViewerTheme`; colors as hex) |
| `urlState` | `false` | read and write the place on the map in the page's URL hash (`#v=…&f=…&s=…&p=…&sc=…`); Back / Forward move between places |
| `storageKey` | `'archMap'` | localStorage prefix of the map's preferences («Camera follows steps», «Go inside», the mouse hints seen); `false` keeps none |
| `keyboard` | `'focus'` | `'focus'`: the map's keys (Esc, arrows, Space, `?`, …) work while focus is inside it, or while the pointer is over it and nothing else has the focus; `'page'`: every key on the page is the map's |
| `debug` | `false` | `handle.probe`: the debug API (the site's `window.archMap`), not a stable API |
| `title`, `name` | the first document's title and id | the overview panel's title; the probe's `project` |
| `nofacets` | `false` | the documents without their facets (the site's `?nofacets=1`) |
| `onSelect(hit)`, `onFocus(id)`, `onError(error)` | — | the selection changed (`{ type, id }` or null); the focus changed (null: the overview); the specs could not be shown |

The handle: `ready` (resolves when the map is drawn), `focus(id | null)`, `select(blockId | null)` (a block's id),
`setSpecs(specs | { specsUrl })`, `setTheme(theme)` (the map is drawn again at the same place: focus and the selected
block), `destroy()` (twice is a no-op; `mount` again on the same element works), `probe`.

- `focus` and `select` before `ready` are ignored (there is no map yet).
- `ready` resolves **without a map** when the mount is destroyed or replaced before it is drawn: `destroy()`,
  `setSpecs`, `setTheme`, or another `mount` on the same element (which destroys the first) while the documents load
  or the element waits for a size. Pending spec fetches are aborted. Destroying or replacing the map from an initial
  callback also releases the scene. A rejected `ready` is marked handled: ignoring it logs nothing.
- `contractsBase` is a folder: a missing trailing `/` is added.
- Two maps on one page share their saved preferences unless each gets its own `storageKey`. Only one map per page
  should use `urlState` (there is one URL hash).

**Errors.** `mount` never throws. Documents that cannot be fetched, a schema major other than the package's, or
documents that do not merge show the map's full-screen notice inside the element, call `onError` with an `Error` that
has `title`, `lines` and `kind` (`'load'`: a document could not be fetched or read, each line names its URL; `'specs'`:
they do not validate or agree; `'map'`: the map could not be shown), and reject `ready`. An element that cannot hold a
shadow root (null, `<figure>`, `<li>`, `<td>`, `<a>`, `<button>`…) gets the same through `onError` and `ready`, and
`console.error`, as there is no element to show the notice in. A host that is shown but still has no size after a
second gets a `console.warn` (the map waits for the size). The rest of the page is untouched.

**Callbacks.** `onFocus` and `onSelect` fire once per change of the place the page has heard: a rebuild
(`setTheme`) that puts the map back at the same place fires nothing; `setSpecs` fires what changed (the focus back
to the overview, say).

**Content-Security-Policy.** No `'unsafe-inline'` needed: the stylesheet is a constructed `CSSStyleSheet` adopted by
each shadow root (parsed once per document, shared by every map on the page), and the markup's per-element custom
properties come as `data-style` and are applied through the CSSOM (`host.ts` `applyDataStyles`) — a CSP blocks
`<style>` elements and `style` attributes, not the CSSOM. Markup strings never carry a `style` attribute.

## How it is isolated

- **Shadow DOM.** The map's stylesheet (`viewer/src/style.css`) is inlined into each shadow root; what was `:root`,
  `html, body` and `body.cinema` / `body.still` is `:host`, `:host(.cinema)`, `:host(.still)`. Every element lookup
  goes through the map's root (`app.$`, `root.getElementById`, `root.activeElement`, `root.elementFromPoint`), so the
  ids of two maps never collide. Fonts are the exception: `@font-face` does not apply from inside a shadow root, so a
  page imports `fonts.css` itself (or names its own families in `theme.fonts`).
- **Host restoration.** Destroy restores the host's pre-existing `data-theme`, inline theme/layout variables
  (including `!important` priorities), `color-scheme`, and `cinema`/`still` class membership. Unrelated host styles
  changed while the map is mounted are preserved.
- **Theme.** The CSS variables, `data-theme` and the relation colors (`--k-<kind>`) are set on the host element; each
  map has its own copy of the relation kinds' colors and its own scene colors. The cinema's black cut and full screen
  are the host's.
- **Listeners.** Every listener is registered with the map's `AbortController` signal; observers are disconnected and
  animation frames cancelled on `destroy`; timers belong to the map (`dom.ts` `later`) and do nothing after it.
  `MapScene.dispose()` frees the renderer, the composer and its passes, the controls, every geometry, material and
  texture, forces the WebGL context lost, and removes its canvas and label layer.
- **Layout.** The narrow layout (the panel under the map, the step bar between them) follows the map's own width:
  `:host` is a size container (`container-type: inline-size`) and the 900 / 600 px rules are `@container` rules; the
  step bar's place follows a ResizeObserver on the host. The containment takes away the host's own width, so `:host`
  has `width: 100%` where the page leaves it auto (a host in a flex row collapsed to 0 before). In an element of a
  given height the narrow map scrolls inside it, the stage sized from the host's height (`--host-h`, not the
  viewport), and "Details" scrolls only that scroller; a page that lets the map grow sets `#host { height: auto; --arch-map-narrow-height: auto;
  --arch-map-narrow-overflow: visible }` on narrow screens and scrolls itself (the site does).
- **Page-wide effects** are scoped to the host: a pinch (ctrl-wheel) and Safari's gesture events are prevented only
  over the map; Shift + drag rotates through OrbitControls' own modifier (wherever the focus is); Control is heard on
  the window (OrbitControls hears it on the canvas's root node — inside a shadow root only while the map has the
  focus — and a Ctrl + mouse wheel was taken for a pinch); the map's keys follow `keyboard`; full screen is tested on
  the host's own root (`fullscreenElement` of a shadow root around the map); the stage's box on the page is read again
  on each pointer event and drawn frame (the page around a map moves it without a window scroll); `location` and `history` are read and written
  only with `urlState: true`, and the page's `history.state` (a router's) is passed through.

## The site is the first consumer

`npm run viewer` serves `viewer/index.html`, whose `src/main.ts` imports the fonts and calls `startSite` (`site.ts`):
it reads `specs/projects.json`, picks the project and documents from `?project=` / `?docs=` (`projects.ts`), resolves
the look from the project and `?theme=` / colors / fonts (`theme.ts`), and mounts the map into `#app` with
`urlState: true, keyboard: 'page', debug: true`, then fills the header's project switcher and sets `window.archMap`.
The browser checks query the map through `mapRoot()` (`test/browser/lib.ts`), the site map's shadow root.

## Checks

- `test/mount.test.ts` — options and defaults, the theme option, document names, the spec check's errors.
- `test/browser/embed.test.ts` + `embed.html` — the built package on a host page of its own: two maps (two demo
  projects, dark and light) with real wheel, clicks and keys in each; destroy and re-mount ten times with the WebGL
  context and the window/document listener counts; a bad spec; a container sized late; `<arch-map>` from the ES
  modules with three from an import map; the host page's styles, URL and history unchanged.
