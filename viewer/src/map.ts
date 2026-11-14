// One map: the controller over checked spec documents, in its host's shadow root (index.ts `mount` makes the root and
// checks the specs; this file wires everything else). Everything it starts — listeners, observers, timers, animation
// frames, the WebGL context — belongs to this map and ends with `destroy`.
//
// One way down and up: the focus. What is open on the map follows from it (and from a traced path), so there is no
// separate «detail level». At rest: the client layer — actors and systems (AD-11); go into a block to see its parts and
// only its relations. `#v=tech` rests on the technical overview instead (systems and service apps open).
import { buildModel, KINDS, setDepths } from './model.ts';
import { scenariosOf, scenarioPanelHtml } from './scenario.ts';
import { queryIn, prefsOf, keepFocus, revealCurrentStep, later, endTimers, isNarrow, isFullscreen } from './dom.ts';
import { LazyDocs, contractsLoaded } from './load.ts';
import { applyDataStyles } from './host.ts';
import { bind } from './app.ts';
import * as view from './view.ts';
import * as bars from './bars.ts';
import * as history from './history.ts';
import * as player from './play.ts';
import * as cinema from './cinema.ts';
import * as focus from './focus.ts';
import * as actions from './actions.ts';
import { setupSearch } from './search.ts';
import { announce, selectionStatus } from './a11y.ts';
import { setupHelp } from './help.ts';
import { setupMapKeys } from './map-keys.ts';
import { setupMenus, setMotion } from './menus.ts';
import { setupCard, onHover, showCard, hideCard, type Card } from './card.ts';
import { debugApi, type MapProbe } from './probe.ts';
import { MapScene } from './scene.ts';
import { contractIndex, nodeHtml, edgeHtml, overviewHtml, pathHtml, fillSchema, envelopeHtml } from './panel.ts';
import { envelopeContext } from './envelopes.ts';
import { adaptSpecs } from './spec-adapter.ts';
import type { App, AppState, CineState, MapOpts, SetLater, UiState } from './app.ts';
import type { Theme } from './theme.ts';
import type { Kinds } from './model.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { Hit, ScreenPoint } from '../../types/scene.ts';
import type { MergedSet, SpecEntry } from '../../types/core.ts';

/** What a map is made from: its host and root, checked specs, look, options and the page's callbacks. */
export interface MapInput {
    host: HTMLElement;
    root: ShadowRoot;
    opts: MapOpts & { debug: boolean; nofacets: boolean };
    theme: Theme;
    kinds: Kinds;
    merged: MergedSet;
    docs: SpecEntry[];
    contractNames: Set<string>;
    loadContract: (name: string) => Promise<unknown>;
    /** the overview panel's title, and the name the debug API gives (`project`) */
    title: string;
    name: string;
    onSelect?: (hit: Hit | null) => void;
    onFocus?: (id: ElementId | null) => void;
}

/** A drawn map: its context, the debug API, and the end of it. */
export interface MapInstance {
    app: App;
    probe: MapProbe;
    destroy(): void;
}

const newUi = (statusHints: boolean): UiState => ({
    barWatch: null, hintTimer: 0, toastTimer: 0, statusHints, lastStats: null, unresolved: null,
    restoring: false, appliedHash: null, cineEl: null, veilEl: null,
});

const newState = (): AppState => ({
    focus: null,
    view: 'client', // 'client' | 'tech': what is open at rest
    scenario: null, // { id, i } while a scenario plays
    selected: null, // { type: 'node'|'edge', id }
    path: null, // { title, steps, callers, start, method }
    hover: null,
    filters: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.on])),
    gap: 34,
    auto: true,
    pulses: true,
    tint: 'kind',
    cooldown: 0,
    folded: [],
} as Omit<AppState, SetLater> as AppState);

/** Whose keys are these (opts.keyboard): 'page' — every key; 'focus' — the host has the focus, or the pointer while nothing else does. */
function keyGate(host: HTMLElement, keyboard: MapOpts['keyboard'], signal: AbortSignal): (e: KeyboardEvent) => boolean {
    if (keyboard === 'page') return () => true;
    let over = false;
    host.addEventListener('pointerenter', () => (over = true), { signal });
    host.addEventListener('pointerleave', () => (over = false), { signal });
    return (e) => e.composedPath().includes(host) || (over && (!document.activeElement || document.activeElement === document.body));
}

/** The context of a new map: model, scene, state and the map's own pieces; the parts' functions are bound later. */
function makeApp(input: MapInput, controller: AbortController, hooks: { hover: App['scene']['handlers']['hover']; click: (hit: Hit | null, at: ScreenPoint & { touch?: boolean }) => void; toggle: (id: ElementId) => void }): App {
    const { host, root, opts, theme, kinds, merged, docs } = input;
    const signal = controller.signal;
    const prefs = prefsOf(opts.storageKey);
    const keyFor = keyGate(host, opts.keyboard, signal);
    const model = buildModel(adaptSpecs(merged, docs, { nofacets: opts.nofacets }));
    setDepths(model);
    const app = { host, root, $: queryIn(root), signal, opts, theme, kinds, prefs, keyFor, timers: new Set<number>(), ui: newUi(!prefs.get('hintsSeen', false)) } as unknown as App;
    const contractDocs = new LazyDocs(input.contractNames, () => contractsLoaded(app), input.loadContract);
    const cine: CineState = { on: false, playing: false, phase: 'step', timers: [], t0: 0, ms: 0, elapsed: 0, idle: 0 };
    const scene = new MapScene(app.$('#stage'), {
        hover: hooks.hover,
        click: hooks.click,
        toggle: hooks.toggle,
        zoom: (z) => app.autoZoom(z),
        cameraStart: () => (app.hideCard(), app.dropStatusHints(true), cine.on && app.pauseCinema()), // a card must never sit under the cursor while the map moves; the person takes the camera from the cinema
        stats: (s) => app.renderStats(s),
    }, { theme, kinds, signal, root });
    const api = contractIndex(contractDocs);
    Object.assign(app, { model, scene, state: newState(), scenarios: scenariosOf(model), cine, contractDocs, api, envCtx: envelopeContext(merged, contractDocs) });
    return app;
}

/** The panel: what is selected, else the path, the scenario, or the overview. */
function renderPanelNow(app: App, title: string): void {
    const { model, state, api, envCtx, scenarios } = app;
    const panel = app.$('#panel');
    const ctx = { model, api, focus: state.focus, rest: app.restSet() };
    const s = state.selected;
    const sc = app.currentScenario();
    if (s?.type === 'node' && model.nodes.get(s.id)) panel.innerHTML = nodeHtml(model.nodes.get(s.id)!, ctx);
    else if (s?.type === 'edge' && state.foldedById.get(s.id)) panel.innerHTML = edgeHtml(state.foldedById.get(s.id)!, { ...ctx, env: envCtx });
    else if (s?.type === 'envelope') panel.innerHTML = envelopeHtml(s.id, { ...ctx, env: envCtx, folded: state.folded, scenarios });
    else if (state.path) panel.innerHTML = pathHtml(state.path, ctx);
    else if (sc) panel.innerHTML = scenarioPanelHtml(sc, state.scenario!.i, (id) => model.nodes.get(id)?.title ?? id, app.stepContractHtml(sc.steps[state.scenario!.i]));
    // the overview: the project, then its main scenario (in either view), how to look, the sources folded
    else panel.innerHTML = overviewHtml(model, { title }, scenarios);
    panel.scrollTop = 0;
    if (!s && !state.path && sc) revealCurrentStep(panel);
}

/** The panel's own listeners: a schema opened loads the contracts; ↑ ↓ (Home, End) move between a scenario's steps. */
function wirePanel(app: App): void {
    const panel = app.$('#panel');
    const on = { signal: app.signal };
    // leaving the cinema brings the panel back: the current step is scrolled into view then (the panel could not be measured while hidden)
    const watch = new MutationObserver(() => {
        if (!app.host.classList.contains('cinema') && app.currentScenario() && !app.state.selected && !app.state.path) revealCurrentStep(panel);
    });
    watch.observe(app.host, { attributes: true, attributeFilter: ['class'] });
    app.signal.addEventListener('abort', () => watch.disconnect());
    panel.addEventListener('toggle', (e) => (e.target as Element).matches?.('details[data-schema]') && app.contractDocs.load().then(() => !app.dead && fillSchema(e.target as HTMLDetailsElement, app.api)), { capture: true, signal: app.signal });
    // the scenario's steps in the panel: ↑ ↓ (Home, End) move between them, Enter or Space plays one; ← → step as anywhere
    panel.addEventListener('keydown', (e) => {
        const b = (e.target as Element).closest?.<HTMLElement>('.sc-steps button');
        if (!b || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
        const all = [...panel.querySelectorAll<HTMLElement>('.sc-steps button')];
        const i = all.indexOf(b);
        const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)));
        e.preventDefault();
        all[j].focus();
    }, on);
}

/** The page-wide listeners of one map, each scoped to it: clicks on its action buttons, its keys, a pinch over it, the URL. */
function wireHost(app: App): void {
    const { host, root, signal } = app;
    root.addEventListener('click', (e) => actions.onDocumentClick(app, e as MouseEvent), { signal });
    window.addEventListener('keydown', (e) => actions.onWindowKey(app, e), { signal });
    // a pinch anywhere in the map (over the panel, the bars, the legend) never zooms the page; nor does Safari's own gesture
    host.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false, signal });
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) host.addEventListener(t, (e) => e.preventDefault(), { passive: false, signal });
    if (!app.opts.urlState) return;
    // Back / Forward (popstate) and a link typed into the address bar (hashchange); pushState/replaceState fire neither
    window.addEventListener('popstate', () => app.applyFromUrl(), { signal });
    window.addEventListener('hashchange', () => app.applyFromUrl(), { signal });
}

/** The scene's pointer hooks: a click selects, a double-click goes in, a tap also brings up the card. */
function pointerHooks(get: () => { app: App; card: Card }) {
    return {
        hover: (hit: Hit | null, at?: ScreenPoint) => onHover(get().app, get().card, hit, at),
        click: (hit: Hit | null, at: ScreenPoint & { touch?: boolean }) => {
            const { app, card } = get();
            if (!hit || hit.type === 'layer') return app.hideCard(), app.select(app.state.focus ? { type: 'node', id: app.state.focus } : null);
            app.select(hit);
            // a touch has no hover: a tap on a block also brings up its card (Enter, Path, Details) where the finger is — on a
            // narrow screen the panel is below the map
            if (at?.touch && hit.type === 'node') {
                showCard(app, card, hit.id, at);
                card.el.pinned = true;
            }
        },
        toggle: (id: ElementId) => {
            const { app } = get();
            const n = app.model.nodes.get(id);
            if (!n) return;
            if (n.children.length && app.state.focus !== id) app.setFocus(id, { enter: true });
            else app.select({ type: 'node', id });
        },
    };
}

/** Tells the page (onFocus, onSelect) when the focus or the selection changed, once per change. */
function notifier(app: App, input: MapInput): () => void {
    let focusWas: ElementId | null = null, selWas = '';
    return () => {
        const { focus: f, selected: s } = app.state;
        if (f !== focusWas) {
            focusWas = f;
            input.onFocus?.(f);
        }
        const key = s ? `${s.type}:${s.id}` : '';
        if (key !== selWas) {
            selWas = key;
            input.onSelect?.(s ? { ...s } : null);
        }
    };
}

/**
 * Draws a map from checked specs into its host's root. A setup that throws partway (no WebGL, say) leaves nothing
 * running: the listeners go with the signal, the timers end, the scene (if it was made) is disposed; then it rethrows.
 */
export function createMap(input: MapInput): MapInstance {
    const controller = new AbortController();
    const made: { app?: App } = {};
    try {
        return drawMap(input, controller, made);
    } catch (err) {
        controller.abort();
        if (made.app) {
            endTimers(made.app);
            made.app.scene?.dispose();
        }
        throw err;
    }
}

function drawMap(input: MapInput, controller: AbortController, made: { app?: App }): MapInstance {
    applyDataStyles(input.root, controller.signal); // the markup's custom properties (`data-style`: CSP, host.ts)
    const held: { card?: Card } = {}; // the card is made once the context is (the scene's hooks reach it through this)
    const app: App = (made.app = makeApp(input, controller, pointerHooks(() => ({ app, card: held.card! }))));
    const { state, scene } = app;
    const card = (held.card = setupCard(app));
    const notify = notifier(app, input);
    function select(hit: Hit | null): void {
        const had = state.selected;
        state.selected = hit;
        if (hit || had) announce(app, selectionStatus(app, hit)); // a selection cleared is said too, nothing selected at load is not
        app.renderPanel();
        app.updateView();
        app.writeHash();
        notify();
    }
    // the parts of the controller get their functions on the context before anything runs: what map.ts keeps that they
    // call (the panel, the selection, the card), then each part's own
    Object.assign(app, { renderPanel: () => keepFocus(app.$('#panel'), () => renderPanelNow(app, input.title)), select, hideCard: () => hideCard(app, card) });
    bind(app, view, bars, history, player, cinema, focus);
    const relayout = app.relayout;
    app.relayout = () => (relayout(), notify());
    wirePanel(app);
    // the map takes the keyboard too: the arrows select its blocks, Enter goes in, Shift + arrows pan, + − zoom (map-keys.ts)
    setupMapKeys(app);
    preferences(app);
    // the cinema's overlay and veil are made here (they come after the map in the page)
    cinema.setupCinema(app);
    const help = setupHelp(app); // the «?» sheet: every control and shortcut, from any state
    setupMenus(app);
    setupSearch(app);
    wireHost(app);
    later(app, () => app.dropStatusHints(false), 10000);
    app.renderLegend();
    app.dropHintOnTurn();
    app.applyHash();
    if (input.opts.debug) performance.mark('archMap:ready'); // the map is laid out (tests and perf checks measure start-up to here)
    later(app, () => app.settle(), 1300);
    notify();
    let gone = false;
    const destroy = () => {
        if (gone) return;
        gone = true;
        controller.abort();
        app.clearCine();
        endTimers(app);
        app.ui.barWatch?.disconnect();
        if (help.open()) help.toggle(false);
        if (isFullscreen(app.host)) document.exitFullscreen?.().catch(() => {});
        scene.dispose();
        app.host.classList.remove('cinema', 'still');
        for (const p of ['--sb-h', '--top-h', '--host-h']) app.host.style.removeProperty(p);
    };
    return { app, probe: debugApi(app, input.name, help), destroy };
}

/**
 * The saved and the system preferences: «Camera follows steps» and «Go inside» (storageKey), prefers-reduced-motion
 * (no pulses, no camera flights or layout motion — cuts instead —, the cinema does not start playing by itself; the
 * View menu's checkboxes still turn each of them back on), and the narrow layout's step bar.
 */
function preferences(app: App): void {
    const { state, scene, prefs } = app;
    state.scCamera = prefs.get('scCamera', true);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    state.pulses = !reducedMotion;
    app.$<HTMLInputElement>('#pulses').checked = state.pulses;
    app.$<HTMLInputElement>('#motion').checked = !reducedMotion;
    setMotion(app, !reducedMotion);
    state.scDeep = prefs.get('scDeep', true);
    // a light page has nothing to glow against: the bloom would wash the whole map out (it can still be turned on)
    if (app.theme.mode === 'light') {
        app.$<HTMLInputElement>('#glow').checked = false;
        scene.glow = false;
    }
    // a narrow screen (the panel under the map): the step bar leaves the map and sits between it and the panel, so it
    // covers none of the map
    let narrow: boolean | null = null;
    const placeStepbar = () => {
        if (narrow === isNarrow(app.host)) return;
        narrow = isNarrow(app.host);
        if (narrow) app.$('#stage').after(app.$('#stepbar'));
        else app.$('#stage').append(app.$('#stepbar'));
    };
    const watch = new ResizeObserver(placeStepbar); // the map's own width, not the screen's
    watch.observe(app.host);
    app.signal.addEventListener('abort', () => watch.disconnect());
    placeStepbar();
}
