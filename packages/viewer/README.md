# @arch-map/viewer

An interactive 3D map of a system's architecture — systems, apps, modules, tables, the relations between them,
scenarios that play as a cinema — drawn in the browser from **arch-map spec documents** (JSON; the format is in
`schema/` of this package). `mount()` puts the whole map (search, scenarios, panel, status line, help) into any
element: it renders into that element's shadow root, touches nothing else on the page, and `destroy()` removes it
completely. Several maps can live on one page.

## Install

```bash
npm install @arch-map/viewer
```

`three` comes with it, pinned to the 0.186 line (the trackpad pinch relies on its internals); an app that uses
another three keeps its own, and the map gets a copy of its own. React is optional (only for
`@arch-map/viewer/react`).

## Use

```js
import { mount } from '@arch-map/viewer';
import '@arch-map/viewer/fonts.css'; // the map's fonts (or your own: see `theme.fonts`)

const map = mount(document.getElementById('map'), {
    specsUrl: ['specs/backend.json', 'specs/client.json'], // contracts load lazily from the same folder
    theme: 'light',
    onSelect: (hit) => console.log('selected', hit),
});
await map.ready;
map.focus('backend.orders');
// later
map.destroy();
```

Give the element a height (the map fills it; its width is the parent's): `#map { height: 600px }`. Mount into a
`<div>` (or another element that can hold a shadow root: `section`, `main`, `article`, a custom element…).

### A spec document

The smallest map: two apps and a database. The format is described by `schema/spec.schema.json`; arch-map's
generators write such documents from code.

```json
{
  "schemaVersion": "1.3.0", "id": "shop", "title": "Shop",
  "elements": [
    { "id": "web", "type": "app", "parent": null, "name": "Web app", "tier": "ui", "provenance": "authored" },
    { "id": "api", "type": "app", "parent": null, "name": "API", "tier": "service", "provenance": "authored" },
    { "id": "db", "type": "datastore", "parent": null, "name": "Database", "provenance": "authored" }
  ],
  "edges": [
    { "id": "web>api:rest", "from": "web", "to": "api", "channel": "rest", "provenance": "authored" },
    { "id": "api>db:read", "from": "api", "to": "db", "channel": "read", "provenance": "authored" }
  ]
}
```

`mount(el, { specs: [doc] })` draws it from the object; `specsUrl` fetches it.

### A script tag (three bundled)

A classic script, not a module: load it with `<script src>` (the export `@arch-map/viewer/iife` is only its path;
`import()` of it defines no global).

```html
<link rel="stylesheet" href="https://unpkg.com/@arch-map/viewer@1/dist/fonts.css">
<div id="map" style="height: 600px"></div>
<script src="https://unpkg.com/@arch-map/viewer@1/dist/arch-map.iife.js"></script>
<script>ArchMap.mount(document.getElementById('map'), { specsUrl: ['specs/a.json'] });</script>
```

### A custom element

```js
import '@arch-map/viewer/element';
```
```html
<arch-map src="specs/a.json,specs/b.json" theme="dark" style="height: 600px"></arch-map>
```

`src` and `theme` follow attribute changes; `el.specs = [doc, …]` takes objects; `el.options = { … }` (callbacks,
`keyboard`, `storageKey`, …) is read when the map mounts (set it before the element is connected); `el.handle` is
the mounted map. `defineArchMap('another-map')` registers an additional tag with its own constructor;
repeating the same tag is a no-op.

### React

```jsx
import { ArchMap } from '@arch-map/viewer/react';
<ArchMap specsUrl={['specs/a.json']} theme="light" style={{ height: 600 }} onFocus={(id) => …} onHandle={(h) => (map = h)} />
```

`specs` / `specsUrl` and `theme` follow later renders: a new array is compared by content (an equal inline array
changes nothing; edited documents are detected even when their names, ids and schema versions stay the same), the
same array is no change (edit documents as React state is edited: into new objects);
the callbacks always call the latest ones; every other option is read once, when the map mounts. `onHandle(handle)`
gives the handle (null after unmount). The map lives in a `<div>` inside the one that gets `className` and `style`.

## Options

| Option | Default | |
|---|---|---|
| `specs` | — | the documents as objects (`doc` or `{ name, doc }`) |
| `specsUrl` | — | the documents' URLs |
| `loadContract(name)` | fetch from `contractsBase` | loads a contract document (OpenAPI, JSON Schema) on first use |
| `contractsBase` | folder of the first URL | |
| `theme` | `'dark'` | `'dark'`, `'light'` or `{ base, colors, fonts }` |
| `urlState` | `false` | keep the place on the map in the page's URL hash; Back / Forward |
| `storageKey` | `'archMap'` | localStorage prefix of the preferences; `false` keeps none |
| `keyboard` | `'focus'` | `'focus'`: keys work while the map has the focus or the pointer; `'page'`: every key |
| `debug` | `false` | the debug API on `handle.probe` (for the console and tests; not a stable API) |
| `title`, `name` | the first document's title / id | the overview panel's title; the probe's `project` |
| `nofacets` | `false` | draw the documents without their facets |
| `onSelect`, `onFocus`, `onError` | — | callbacks |

Two maps on one page share their saved preferences unless each has its own `storageKey`. Only one map per page
should use `urlState` (there is one URL hash).

The handle: `ready`, `focus(id)`, `select(blockId)`, `setSpecs(specs | { specsUrl })`, `setTheme(theme)`,
`destroy()`, `probe`. `focus` and `select` before `ready` are ignored. `ready` resolves without a map when the mount
is destroyed or replaced (a second `mount` on the same element destroys the first) before it is drawn.
Destroying or replacing a loading map aborts its spec requests and resolves its abandoned `ready`. Calling
`destroy()` from an initialization callback is supported. Destroy restores the host's pre-existing theme values
and map-related classes, including inline property priorities.
Errors (unreadable or incompatible specs) show a notice inside the element, call `onError` and reject `ready`;
`error.kind` says which: `'load'`, `'specs'` or `'map'`. `mount` itself never throws: an element that cannot hold
the map (null, a `<figure>`, a `<td>`…) is reported the same way and on the console. The package's major version is
the spec schema's major.

**Content-Security-Policy.** The map needs no `'unsafe-inline'`: its styles are a constructed stylesheet and set
through the CSSOM. A policy such as `default-src 'self'` (or `style-src` / `font-src` / `script-src` naming where
`fonts.css`, the fonts and the package are served, and `connect-src` where the specs are) is enough.

Arch-map is MIT licensed. Bundled fonts retain their SIL Open Font License; original copyright and license texts
are in `dist/licenses/<font-family>.txt`. The IIFE includes three.js under MIT, with its notice in the script and
`dist/licenses/three.txt`. Keep these third-party notices when redistributing the assets.
