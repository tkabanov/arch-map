// Links: the place on the map is in the URL (#v=tech&f=<focus>&s=<node>&p=<id>|<method>&sc=<scenario>:<step>): writing it,
// and going to the place a URL names.
import { focusOf } from './model.ts';
import { later } from './dom.ts';
import type { App } from './app.ts';

// ---------- links: #v=tech&f=<focus>&s=<node>&p=<id>|<method>&sc=<scenario>:<step> ----------
/**
 * The place on the map is in the URL (with `urlState`; an embedded map never reads or writes the page's URL). A new
 * place (another focus, a path, the view, a scenario opened or closed) is a history entry — the browser's Back and
 * Forward go between them; a selection or a scenario step only replaces it. `app.ui.restoring`: applying the URL —
 * what it writes back replaces, never pushes.
 */
/** The hash the map reads its place from: the page's, or none without `urlState`. */
const hashOf = (app: App): string => (app.opts.urlState ? location.hash : '');

const placeKey = (h: string) => {
    const q = new URLSearchParams(String(h).replace(/^#/, ''));
    q.delete('s');
    const sc = q.get('sc');
    if (sc) q.set('sc', sc.slice(0, sc.lastIndexOf(':')));
    return q.toString();
};

export function writeHash(app: App): void {
    const { state } = app;
    const p = new URLSearchParams();
    if (state.view === 'tech') p.set('v', 'tech');
    if (state.scenario && !state.path) p.set('sc', `${state.scenario.id}:${state.scenario.i + 1}`);
    if (state.path) p.set('p', `${state.path.start}|${state.path.method}`);
    else if (state.focus) p.set('f', state.focus);
    if (state.selected?.type === 'node') p.set('s', state.selected.id);
    const next = p.toString() ? `#${p}` : '';
    if (!app.opts.urlState || location.hash === next) return;
    const push = !app.ui.restoring && placeKey(location.hash) !== placeKey(next);
    // the page's own state (a router's key and index) goes along: the map changes only the hash
    history[push ? 'pushState' : 'replaceState'](history.state, '', next || location.pathname + location.search);
    app.ui.appliedHash = location.hash;
}

/** Back, Forward, or a link typed in: the map goes to the place in the URL, the camera flies there. */
export function applyFromUrl(app: App): void {
    const { cine, ui } = app;
    if (!app.opts.urlState || location.hash === ui.appliedHash) return; // popstate and hashchange both come for one step back
    ui.appliedHash = location.hash;
    if (cine.on) app.exitCinema();
    app.applyHash(true);
}

export function applyHash(app: App, fromHistory = false): void {
    app.ui.restoring = true;
    try {
        app.applyHashNow(fromHistory);
    } finally {
        app.ui.restoring = false;
        app.ui.appliedHash = hashOf(app);
    }
}

export function applyHashNow(app: App, fromHistory: boolean): void {
    const { state, model } = app;
    const p = new URLSearchParams(hashOf(app).slice(1));
    const path = p.get('p');
    const sel = p.get('s');
    state.view = p.get('v') === 'tech' ? 'tech' : 'client';
    const sc = p.get('sc');
    state.scenario = null;
    if (sc) scenarioFromHash(app, sc);
    if (path) {
        const [id, m] = path.split('|');
        if (model.nodes.has(model.nodeOf(id))) return app.startPath(model.nodeOf(id), m);
        app.missing(id);
    }
    focusFromHash(app, p, sel);
    app.relayout();
    if (fromHistory) {
        // fly while the layout moves, then measure the new level for the wheel
        if (state.scenario && !state.path && !state.focus) later(app, () => app.stepCamera(), 30);
        else app.frameFocus();
        later(app, () => app.settle(), 1250);
    } else if (state.focus) later(app, () => app.frameFocus(), 500);
}

/** `sc=<scenario>:<step>`: the scenario that is playing (a step out of range is the nearest one). */
function scenarioFromHash(app: App, sc: string): void {
    const { state, scenarios } = app;
    const k = sc.lastIndexOf(':');
    const id = k > 0 ? sc.slice(0, k) : sc;
    const s = scenarios.find((x) => x.id === id);
    if (s) state.scenario = { id, i: Math.max(0, Math.min(s.steps.length - 1, (Number(sc.slice(k + 1)) || 1) - 1)) };
    else app.missing(id);
}

/** `f=<focus>` and `s=<node>`: the focus (not what is open at rest) and the selection (else the focus itself). */
function focusFromHash(app: App, p: URLSearchParams, sel: string | null): void {
    const { state, model } = app;
    const f = p.get('f') && model.nodeOf(p.get('f')!);
    const s = sel && model.nodeOf(sel);
    if (f && !model.nodes.has(f)) app.missing(f);
    else if (s && !model.nodes.has(s)) app.missing(s);
    const ff = f && model.nodes.has(f) ? focusOf(model, model.nodes.get(f)!.children.length ? f : model.nodes.get(f)!.parent!) : null;
    state.focus = ff && !app.restSet().has(ff) ? ff : null;
    state.selected = s && model.nodes.has(s) ? { type: 'node', id: s } : state.focus ? { type: 'node', id: state.focus } : null;
}

/** A link to something that is not in the loaded specs opens the map with a message. */
export function missing(app: App, id: string): number {
    return later(app, () => app.toast(`Not in the specs: ${id}`), 50);
}
