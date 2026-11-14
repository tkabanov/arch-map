// @arch-map/viewer: the architecture map as a component. `mount(container, options)` renders the whole map (bars, panel,
// status line, help) into an open shadow root of `container` from spec documents given as objects or URLs, owns nothing
// outside that element, and tears down fully on `destroy()`. docs/embedding.md.
import { createMap, type MapInstance } from './map.ts';
import { prepareHost, clearHost, preserveHost, whenSized } from './host.ts';
import { showNotice, getJson, fetchContracts } from './load.ts';
import { resolveOptions, themeOf, specEntries, checkSpecs, mapError, nameOfUrl, folderOf, type MountOptions, type SpecInput, type MapError } from './options.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { SpecEntry } from '../../types/core.ts';

export type { MountOptions, SpecInput, MapError, MapErrorKind } from './options.ts';
export type { ViewerTheme, ThemeColors } from '../../types/project.ts';
export type { ArchMapSpecDocument } from '../../types/spec.d.ts';
export { SCHEMA_MAJOR } from './spec-adapter.ts';

/** A mounted map. */
export interface ArchMapHandle {
    /** resolves when the map is drawn; rejects (with the error `onError` got) when the specs could not be shown */
    ready: Promise<void>;
    /** goes into a block (null: back to the overview) */
    focus(id: ElementId | null): void;
    /** selects a block (null: nothing) */
    select(id: ElementId | null): void;
    /** draws other spec documents in the same element; resolves like `ready` */
    setSpecs(specs: SpecInput[] | { specsUrl: string[] }): Promise<void>;
    /** another look (the map is drawn again in it, at the same place); resolves like `ready` */
    setTheme(theme: MountOptions['theme']): Promise<void>;
    /** removes the map: every listener, timer, animation frame and the WebGL context; the element is left empty. Twice is a no-op */
    destroy(): void;
    /** the debug API (`debug: true`), else null: for the console and tests, not a stable API (its shape is `MapProbe`) */
    readonly probe: unknown;
}

/** The documents of a mount: as given, or fetched by URL (in order; the names they `require` each other by are the file names). */
async function loadEntries(specs: SpecInput[] | undefined, urls: string[] | undefined, signal: AbortSignal): Promise<SpecEntry[]> {
    if (specs) return specEntries(specs);
    const list = urls ?? [];
    const failed: string[] = [];
    const docs = await Promise.all(list.map((url) => getJson(url, signal).catch((err) => void failed.push(String(err?.message ?? err)))));
    if (failed.length) throw mapError('Could not load the specs', failed, 'load');
    return specEntries(list.map((url, i) => ({ name: nameOfUrl(url), doc: docs[i] as SpecEntry['doc'] })));
}

/** What a map takes from the options as given: the contract loader, its names, the page's callbacks. */
function fromOptions(options: MountOptions, urls: string[] | undefined, entries: SpecEntry[], told: Told, signal: AbortSignal) {
    const given = options.contractsBase ?? (urls?.length ? folderOf(urls[0]) : '');
    const base = given && !given.endsWith('/') ? `${given}/` : given; // a folder: names are appended to it
    return {
        loadContract: options.loadContract ?? fetchContracts(base),
        title: options.title ?? entries[0]?.doc.title ?? 'Architecture',
        name: options.name ?? entries[0]?.doc.id ?? '',
        ...liveCallbacks(options, told, signal),
    };
}

/**
 * What the page last heard through `onFocus` and `onSelect`, across the builds of one mount. While a build draws the
 * map and puts it back at its place (`quiet`), nothing is told; then only what differs from what the page heard.
 */
interface Told { focus: ElementId | null; selected: string; quiet: boolean }
const hitKey = (hit: { type: string; id: string } | null): string => (hit ? `${hit.type}:${hit.id}` : '');

/** Consumer callbacks stop with their build, including callbacks fired inside createMap. */
function liveCallbacks(options: MountOptions, told: Told, signal: AbortSignal): Pick<MountOptions, 'onSelect' | 'onFocus'> {
    return {
        onSelect(hit) {
            if (signal.aborted || told.quiet || hitKey(hit) === told.selected) return;
            told.selected = hitKey(hit);
            options.onSelect?.(hit);
        },
        onFocus(id) {
            if (signal.aborted || told.quiet || id === told.focus) return;
            told.focus = id;
            options.onFocus?.(id);
        },
    };
}

/** After a build: the page hears the place the map is at, where it differs from what it last heard. */
function tellPlace(instance: MapInstance, callbacks: Pick<MountOptions, 'onSelect' | 'onFocus'>): void {
    const s = instance.app.state;
    callbacks.onFocus?.(s.focus);
    callbacks.onSelect?.(s.selected ? { ...s.selected } : null);
}

const asMapError = (err: unknown): MapError => (err && typeof err === 'object' && 'lines' in err ? (err as MapError) : mapError('Could not show the map', [String((err as Error)?.message ?? err)]));

function reportError(root: ShadowRoot | null, options: MountOptions, error: unknown): never {
    const e = asMapError(error);
    if (root) showNotice(root, e.title, e.lines); // the notice logs it too
    else console.error(`@arch-map/viewer: ${e.message}`); // nowhere to show it: the console is the one place left
    options.onError?.(e);
    throw e;
}

/** A mount that cannot start (no element, or one that cannot hold a shadow root): told, and a handle that does nothing. */
function failedMount(options: MountOptions, error: MapError): ArchMapHandle {
    const ready = handled(Promise.resolve().then(() => reportError(null, options, error)));
    return { ready, focus() {}, select() {}, setSpecs: () => ready, setTheme: () => ready, destroy() {}, probe: null };
}

/** Why `el` cannot hold a map, or null when it can. */
function unfitHost(el: unknown): MapError | null {
    if (!el || typeof (el as HTMLElement).attachShadow !== 'function') return mapError('Could not show the map', [`mount() needs an element, got ${el === null ? 'null' : typeof el}`]);
    const host = el as HTMLElement;
    if (host.shadowRoot && host.shadowRoot.mode !== 'open') return mapError('Could not show the map', [`<${host.localName}> already has a closed shadow root`]);
    if (host.shadowRoot) return null;
    // the elements that can hold a shadow root: custom elements and these (DOM standard, attachShadow)
    const ok = host.localName.includes('-') || /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/.test(host.localName);
    return ok ? null : mapError('Could not show the map', [`<${host.localName}> cannot hold a shadow root: mount the map into a <div> (or a <section>, <main>, <article>…)`]);
}

/** The live map of each element: a second `mount` on the same element destroys the first. */
const mounted = new WeakMap<HTMLElement, ArchMapHandle>();

/** `ready` as the handle gives it: rejected promises are marked handled here (the notice and `onError` already told). */
const handled = (p: Promise<void>): Promise<void> => (p.catch(() => {}), p);

/** Validates once, before allocating a scene or waiting for the host's size. */
function checkedSpecs(entries: SpecEntry[]) {
    const check = checkSpecs(entries);
    if (!check.ok) throw mapError(check.title, check.lines, 'specs');
    for (const warning of check.warnings) console.warn(warning);
    return check;
}

type Place = { focus: ElementId | null; selected: ElementId | null };
const placeOf = (instance: MapInstance): Place => {
    const s = instance.app.state;
    return { focus: s.focus, selected: s.selected?.type === 'node' ? s.selected.id : null };
};

/** Draws a map and puts it back at `keep` while the page hears nothing (`told.quiet`). */
function drawQuietly(told: Told, draw: () => MapInstance, keep: Place | undefined, signal: AbortSignal): MapInstance {
    told.quiet = true;
    try {
        const next = draw();
        if (!signal.aborted) restorePlace(next, keep);
        return next;
    } finally {
        told.quiet = false;
    }
}

/** Puts a new build back at the place of the one it replaces (the page is not told: `quiet`). */
function restorePlace(instance: MapInstance, keep: Place | undefined): void {
    if (keep?.focus) instance.app.setFocus(keep.focus);
    if (keep?.selected) instance.app.select({ type: 'node', id: keep.selected });
}

/**
 * Renders the map into `el` (its open shadow root). Never throws: a problem with the specs shows the map's notice in
 * `el`, calls `onError` and rejects `ready`. A map already mounted in `el` is destroyed first. `ready` resolves without
 * a map when the mount is destroyed or replaced before it is drawn.
 */
export function mount(el: HTMLElement, options?: MountOptions | null): ArchMapHandle {
    const given = options ?? {};
    const unfit = unfitHost(el);
    if (unfit) return failedMount(given, unfit);
    mounted.get(el)?.destroy();
    const opts = resolveOptions(given);
    let theme = themeOf(given.theme);
    let specs = given.specs, urls = given.specsUrl;
    let entries: SpecEntry[] | null = null;
    let instance: MapInstance | null = null;
    let pending: Place | undefined; // where a build in progress puts the map back (a rebuild before it is drawn keeps it)
    const told: Told = { focus: null, selected: '', quiet: false };
    const restoreHost = preserveHost(el);
    let life = new AbortController();
    let destroyed = false;
    const end = () => (life.abort(), instance?.destroy(), (instance = null));
    async function build(keep?: Place): Promise<void> {
        end();
        pending = keep;
        const mine = (life = new AbortController());
        let root: ShadowRoot | null = null;
        try {
            const host = prepareHost(el, theme);
            root = host.root;
            const loaded = entries ?? (await loadEntries(specs, urls, mine.signal));
            if (mine.signal.aborted) return;
            entries = loaded;
            const check = checkedSpecs(loaded);
            await whenSized(el, mine.signal);
            if (mine.signal.aborted) return;
            const page = fromOptions(given, urls, loaded, told, mine.signal);
            const next = drawQuietly(told, () => createMap({ host: el, root: host.root, opts, theme, kinds: host.kinds, merged: check.merged, docs: loaded, contractNames: check.contractNames, ...page }), keep, mine.signal);
            if (mine.signal.aborted) {
                next.destroy();
                if (destroyed && !mounted.has(el)) restoreHost();
                return;
            }
            instance = next;
            pending = undefined;
            tellPlace(next, page); // may destroy or replace this build: nothing after it
        } catch (err) {
            if (mine.signal.aborted) return;
            end();
            reportError(root, given, err);
        }
    }
    const handle: ArchMapHandle = {
        ready: Promise.resolve(),
        focus: (id) => instance?.app.setFocus(id),
        select: (id) => instance?.app.select(id ? { type: 'node', id } : null),
        setSpecs(next) {
            if (destroyed) return Promise.resolve();
            specs = Array.isArray(next) ? next : undefined;
            urls = Array.isArray(next) ? undefined : next.specsUrl;
            entries = null;
            return (handle.ready = handled(build()));
        },
        setTheme(next) {
            if (destroyed) return Promise.resolve();
            theme = themeOf(next);
            return (handle.ready = handled(build(instance ? placeOf(instance) : pending)));
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            end();
            clearHost(el, restoreHost);
            if (mounted.get(el) === handle) mounted.delete(el);
        },
        get probe() {
            return opts.debug && instance ? instance.probe : null;
        },
    };
    mounted.set(el, handle);
    handle.ready = handled(build());
    return handle;
}
