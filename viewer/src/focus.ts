// Where the person is: what is open at rest and around the focus, the layout for it, going into a block and out (the focus), the semantic zoom
// of the wheel (opening a block as it grows, leaving it as it shrinks), Path and links to a thing.
import { KINDS, kindGroup, foldEdges, routeVia, ancestors, inside, visibleAncestor, trace, traceNode, passThrough, focusOf } from './model.ts';
import { stepView } from './scenario.ts';
import { layout } from './layout.ts';
import { hiddenRelations } from './figures.ts';
import { announce } from './a11y.ts';
import { later } from './dom.ts';
import { esc } from './scene-util.ts';
import * as THREE from 'three';
import type { ElementId, MethodName } from '../../types/spec.d.ts';
import type { FoldedEdge, RoutedEdge, ViewNode } from '../../types/viewer.ts';
import type { WheelInfo } from '../../types/scene.ts';
import type { App } from './app.ts';

/** What is open at rest: nothing on the client layer; systems, service apps and datastores with logic in the technical overview. */
export function restSet(app: App): Set<ElementId> {
    const { state, model } = app;
    return passThrough(model, new Set(state.view === 'tech' ? model.tech : []));
}

/** The visible parent to leave to: none above what is open at rest; a single-child chain is one level. */
export function upOf(app: App, id: ElementId): ViewNode | null {
    const { model } = app;
    const pid = model.nodes.get(id)?.parent;
    const p = pid && model.nodes.get(focusOf(model, pid)!);
    return p && !restSet(app).has(p.id) ? p : null;
}

// ---------- what is open ----------
export function expandedFor(app: App): Set<ElementId> {
    const { state, model } = app;
    if (state.all) return new Set([...model.nodes.values()].filter((n) => n.children.length).map((n) => n.id));
    const set = app.restSet();
    const openPath = (id: ElementId) => ancestors(model, id).forEach((a) => set.add(a.id));
    const f = state.focus && model.nodes.get(state.focus);
    if (f) {
        openPath(f.id);
        set.add(f.id);
        // inside a system's parts, neighbours at a useful resolution: their app opens (fronts to areas, MySQL to tables)
        // with the system around it, and «Outside the slice». A focused system keeps the client-layer picture around it.
        if (f.type !== 'system')
            for (const e of model.edges) {
                if (e.kind === 'import' || e.kind === 'references') continue;
                const a = inside(model, e.from, f.id), b = inside(model, e.to, f.id);
                if (a === b) continue;
                const all = ancestors(model, a ? e.to : e.from).reverse();
                all.filter((x) => x.type === 'system').forEach((x) => set.add(x.id));
                const chain = all.filter((x) => x.type !== 'system');
                if (chain[0]) set.add(chain[0].id);
                if (chain[1]?.type === 'group') set.add(chain[1].id);
            }
    }
    if (state.path) for (const s of state.path.steps) [s.from, s.to].forEach(openPath);
    for (const id of app.deepStepIds()) openPath(id);
    return passThrough(model, set);
}

/**
 * «Go inside» for scenarios (on by default): the blocks around the current step's own components open, so the step is
 * shown on the components themselves (a controller, a service, a table), not on the system that holds them. Off, a
 * step plays on whatever the map has open. The cinema's title and end shots stay on the whole picture.
 */
export function deepStepIds(app: App): ElementId[] {
    const { state, cine } = app;
    if (!state.scDeep || !state.scenario || state.path || (cine.on && cine.phase !== 'step')) return [];
    const st = app.currentScenario()?.steps[state.scenario!.i];
    if (!st) return [];
    if (cine.on) return [...new Set(app.currentScenario()!.flow!.legs.flatMap((leg) => [leg.from, leg.to, ...(leg.edge?.via ?? [])]))];
    const via = st.bridge?.nodes ?? []; // the way from the last step is shown at the same depth
    if (st.kind === 'element') return [st.element, ...via];
    // the step's two ends, and the ends of the relations it runs along (a few: an edge step may match many)
    return [...new Set([st.from, st.to, ...st.edges.slice(0, 3).flatMap((e) => [e.from, e.to]), ...via])];
}

function retainedCinemaKeys(app: App, expanded: Set<ElementId>): Set<string> {
    const keys = new Set<string>();
    if (!app.cine.on) return keys;
    for (const leg of app.currentScenario()?.flow?.legs ?? []) {
        if (!leg.edge) continue;
        const e = leg.edge;
        const a = visibleAncestor(app.model, expanded, e.from).id, b = visibleAncestor(app.model, expanded, e.to).id;
        if (a !== b) keys.add(`${a}|${b}|${e.group}`);
    }
    return keys;
}

/** Relations in scope (the map, or what touches the focus) between placed blocks that a legend filter keeps off. */
function hiddenByFilters(app: App, expanded: Set<ElementId>, drawn: FoldedEdge[], placed: { id: ElementId }[]): number {
    const { state, model } = app;
    if (state.path) return 0; // a Path draws its own relations only: no filter applies
    const all = Object.fromEntries(Object.keys(KINDS).map((k) => [k, true]));
    const inScope = foldEdges(model, expanded, all).filter((e) => !state.focus || inside(model, e.from, state.focus) || inside(model, e.to, state.focus));
    return hiddenRelations(inScope, new Set(drawn.map((e) => e.id)), new Set(placed.map((n) => n.id)));
}

export function relayout(app: App): void {
    const { state, model, scene } = app;
    const expanded = app.expandedFor();
    state.expanded = expanded;
    const lay = layout(model, expanded, state.gap);
    let folded: FoldedEdge[];
    if (state.path) {
        // only the relations the path goes along
        const keys = new Set(state.path.steps.filter((s) => s.kind !== 'break').map((s) => `${visibleAncestor(model, expanded, s.from).id}|${visibleAncestor(model, expanded, s.to).id}|${kindGroup(s.kind)}`));
        folded = foldEdges(model, expanded, { ...state.filters, call: true, event: true, data: true, ext: true, rest: true }).filter((e) => keys.has(`${e.from}|${e.to}|${e.group}`));
    } else if (state.focus) {
        const inF = (id: ElementId) => inside(model, id, state.focus!);
        // calls show inside the focus only; in a ui-tier app also across it: a screen's calls into the app's API are
        // what a client app's architecture is, so they stay drawn when the focus is a feature or the API module
        const fApp = app.uiApp(state.focus);
        const sameUiApp = (e: { from: ElementId; to: ElementId }) => fApp && app.uiApp(e.from) === fApp && app.uiApp(e.to) === fApp;
        folded = foldEdges(model, expanded, { ...state.filters, call: true }).filter((e) => (inF(e.from) || inF(e.to)) && (e.group !== 'call' || state.filters.call || (inF(e.from) && inF(e.to)) || sameUiApp(e)));
    } else folded = foldEdges(model, expanded, state.filters);
    // the relations the current scenario step runs along are drawn whatever the legend filters say
    state.step = null;
    const sc = app.currentScenario();
    if (sc && !state.path) {
        state.step = stepView(model, expanded, sc.steps[state.scenario!.i], app.cine.on);
        const retained = retainedCinemaKeys(app, expanded);
        const have = new Set(folded.map((e) => e.id));
        const all = Object.fromEntries(Object.keys(KINDS).map((k) => [k, true]));
        const bridge = new Set(state.step.bridge.keys); // the way from the last step: drawn whatever the filters say
        for (const e of foldEdges(model, expanded, all)) if ((state.step.keys.has(e.id) || bridge.has(e.id) || retained.has(e.id)) && !have.has(e.id)) folded.push(e);
    }
    // after the scenario's own relations are back (they are drawn whatever the filters say), before routeVia (the
    // folded ids still match the fold's)
    state.hiddenByFilters = hiddenByFilters(app, expanded, folded, lay.placed);
    // relations that travel through a gateway / an API server are drawn along it, hops bundled (spec `via`)
    folded = routeVia(model, expanded, folded);
    // an expanded system is a column outline: relations to it end on the column
    const placedIds = new Set(lay.placed.map((n) => n.id));
    folded = folded.filter((e) => placedIds.has(e.from) && placedIds.has(e.to));
    // routeVia above made every one a drawn line (RoutedEdge)
    state.folded = folded as RoutedEdge[];
    state.foldedById = new Map((folded as RoutedEdge[]).map((e) => [e.id, e]));
    state.placed = lay.placed;
    state.placedIds = placedIds;
    scene.setLayout(lay, folded as RoutedEdge[], model);
    if (state.selected?.type === 'edge' && !state.foldedById.has(state.selected.id)) state.selected = null;
    if (state.hover?.type === 'edge' && !state.foldedById.has(state.hover.id)) state.hover = null;
    if (state.selected?.type === 'node' && !state.placedIds.has(state.selected.id)) state.selected = null;
    app.renderPanel();
    app.renderBars();
    app.renderStepbar();
    app.updateView();
    app.writeHash();
}

// ---------- focus ----------
/**
 * Moves the focus to `id` (to its parent for a leaf) and flies the camera there. `enter`: the person asked to go into this
 * block (a double-click, «Enter ⤵» on the card or the panel, the Enter key) — the camera flies in and frames the opened
 * block, as the wheel does when it opens one; without it the frame takes the focus and the other ends of its relations
 * (going up, Leave, a link), which for a block entered from above is a flight out to most of the map.
 */
export function setFocus(app: App, id: ElementId | null | undefined, { anchor = false, select = true, enter = false }: { anchor?: boolean; select?: boolean; enter?: boolean } = {}): void {
    const { state, model, scene } = app;
    const n = id && model.nodes.get(id);
    let f: ElementId | null = n ? (n.children.length ? id! : n.parent) : null;
    if (f) f = focusOf(model, f);
    if (app.restSet().has(f!)) f = null; // what is open at rest has the overview as its focus
    sayFocus(app, f);
    state.all = false;
    state.focus = f;
    state.upRef = state.upDist = null; // set elsewhere: its own size counts, not one measured on the way up
    state.path = null;
    if (select) state.selected = id ? { type: 'node', id } : null;
    if (anchor) scene.anchor = id!;
    app.relayout();
    if (anchor) return; // the wheel opened it and flies there itself
    flyToFocus(app, enter); // while the layout moves, not after it
    later(app, () => settle(app), 1250);
}

/** A new focus is said in `#sr-status` (a11y.ts): «Inside Backend», «Back to the overview»; the selection is not said again. */
function sayFocus(app: App, f: ElementId | null): void {
    if (f !== app.state.focus) announce(app, f ? `Inside ${app.model.nodes.get(f)?.title ?? f}` : 'Back to the overview');
}

/** The flight after a focus change: into the entered block alone, or to the focus and its relations (frameFocus). */
function flyToFocus(app: App, enter: boolean): void {
    if (enter && app.state.focus) app.scene.fitIds(new Set([app.state.focus]));
    else app.frameFocus();
}

export function frameFocus(app: App): void {
    const { state, model, scene } = app;
    if (state.path) return scene.fitIds(app.pathIds());
    if (!state.focus) return scene.fitAll();
    const ids = new Set<ElementId>();
    const near: ElementId[] = []; // the other ends of the focus's relations
    for (const n of state.placed) {
        if (inside(model, n.id, state.focus)) ids.add(n.id);
        else if (!n._plate && state.folded.some((e) => e.from === n.id || e.to === n.id)) near.push(n.id);
    }
    // a focus in a client (ui-tier) app: the services it talks to open a level down and stand far away, so framing them
    // all leaves the app a speck at the back. Frame the focus and its app, then the neighbours nearest first while the
    // frame stays within FRAME_REACH × the app's radius; the lines run on out of frame, the rest is a pan or a wheel away.
    const uiApp = app.uiApp(state.focus);
    if (uiApp && near.length) {
        const base = new Set(ids);
        for (const n of state.placed) if (inside(model, n.id, uiApp)) base.add(n.id);
        const radius = (s: Iterable<ElementId>) => scene.boxOf(s).getSize(new THREE.Vector3()).length() / 2;
        const r0 = radius(base), c0 = scene.boxOf(base).getCenter(new THREE.Vector3());
        const dist = (id: ElementId) => scene.boxOf([id]).getCenter(new THREE.Vector3()).distanceTo(c0);
        const framed = new Set(base);
        for (const id of near.sort((a, b) => dist(a) - dist(b))) {
            const next = new Set(framed).add(id);
            if (radius(next) > FRAME_REACH * r0) break;
            framed.add(id);
        }
        const all = new Set([...ids, ...near]);
        if (radius(all) > FRAME_REACH * r0) return scene.fitIds(framed);
    }
    near.forEach((id) => ids.add(id));
    scene.fitIds(ids);
}

const FRAME_REACH = 2.3; // see frameFocus

/**
 * Semantic zoom, checked every ~100 ms while the wheel moves the camera. Zooming in goes to what is under the cursor:
 * - a closed block under the cursor opens when it covers ENTER of the map — inside the focus or not (outside it, the
 *   focus moves there); the camera then flies so it fills the frame;
 * - the cursor on a board that is open already but outside the focus (a neighbour's app, another system's parts): the
 *   focus moves to that board after SWITCH_MS of zooming over it, so it never stays on something out of view;
 * - otherwise the closed block of the focus nearest the cursor opens, as before.
 * The focus closes when it shrinks below EXIT: far below the size it had after opening, so the two never fight. A ring
 * on the label (⤵ in, ⇄ the focus moves) and a hint over the map show how close each step is.
 */
const ENTER = 0.035, HINT = 0.35;

const FLOOR = 0.2; // a block with nothing inside: the wheel stops once it covers this share of the map

const GROW = 2; // a block opens only after it has grown at least twice since the level was entered

export function settle(app: App): void {
    const { state, scene } = app;
    state.focusArea = state.focus ? scene.screenArea(state.focus) : null;
    state.baseAreas = new Map(scene.blocksInFrame().map((b) => [b.id, b.a]));
} // a closed block opens at ~7% of the map (about a quarter of its width and height)

const EXIT_SHARE = 0.3; // the focus closes when it shrinks to 30% of the size it had right after opening

export function autoZoom(app: App, { dir, x, y }: WheelInfo): unknown {
    const { state, cine } = app;
    if (!state.auto || state.path || cine.on) return; // the cinema never opens or closes anything
    const now = performance.now();
    if (now < state.cooldown) return;
    if (dir === 'in') return zoomIn(app, x, y, now);
    zoomOut(app, now);
}

/** Zooming in: what the cursor points at opens when it has grown enough, or the focus moves to it, or the zoom is steered/stopped. */
function zoomIn(app: App, x: number, y: number, now: number): unknown {
    const { state, model, scene } = app;
    // what the cursor is on (the dimmed things outside the focus too), nearest first; never «the largest in frame»:
    // that opens what nobody asked for
    const under = scene.nodesAt(x, y).map((id) => model.nodes.get(id)).filter((c): c is ViewNode => Boolean(c));
    const isOpen = (c: ViewNode) => state.expanded.has(c.id);
    const closed = (c: ViewNode | '' | null | undefined): c is ViewNode => !!(c && c.children.length && !isOpen(c));
    const inFocus = (id: ElementId) => !state.focus || inside(model, id, state.focus);
    const top = under.find((c) => !isOpen(c)); // the nearest thing that is not an open board
    let n: ViewNode | null = closed(top) ? top : null;
    const other = !n && app.switchTarget(under, top);
    if (other) return scene.steerZoom(null), app.zoomHint(null), app.armSwitch(other, now);
    state.switching = null;
    if (!n) {
        const near = scene.blockNear(x, y);
        const c = near && model.nodes.get(near);
        n = closed(c) && inFocus(c.id) ? c : null;
    }
    // the cursor points at nothing: the zoom is drawn to the nearest block on screen, so it never flies on into
    // empty space (a block that opens opens as usual; one that does not is where the zoom stops)
    let toward: ViewNode | null | undefined = null;
    if (!n && !top) {
        const far = scene.blockNear(x, y, { max: Infinity, leaves: true, accept: inFocus });
        toward = far ? model.nodes.get(far) : null;
        if (closed(toward)) n = toward;
    }
    scene.steerZoom(toward?.id ?? null);
    if (!n) return nothingToOpen(app, x, y, top ?? toward, toward);
    return growToOpen(app, n, toward, now);
}

/** No block to open under the cursor: the hint says why (nothing here, still far, or the bottom of the map). */
function nothingToOpen(app: App, x: number, y: number, leaf: ViewNode | null | undefined, toward: ViewNode | null | undefined): unknown {
    const { scene } = app;
    scene.setPreview(null);
    if (!leaf) return scene.zoomFloor({ x, y }), app.zoomHint('Nothing here to zoom into — zoom out or use View › Fit');
    if (scene.screenArea(leaf.id) < FLOOR) return app.zoomHint(toward ? `Zooming toward <b>${esc(leaf.title)}</b>` : null);
    scene.zoomFloor({ x, y });
    return app.zoomHint(`<b>${esc(leaf.title)}</b> has nothing inside — click it for its details`);
}

/** A closed block under the cursor: the ring fills as it grows, and it opens at the size where it should. */
function growToOpen(app: App, n: ViewNode, toward: ViewNode | null | undefined, now: number): unknown {
    const { state, model, scene } = app;
    const a = scene.screenArea(n.id);
    let base = state.baseAreas?.get(n.id);
    // a block outside the focus was not measured when the level was entered: it has to grow from where it is now
    if (base === undefined && state.focus && !inside(model, n.id, state.focus)) (state.baseAreas ??= new Map()).set(n.id, (base = a));
    base ??= 0;
    const need = Math.max(ENTER, base * GROW);
    const from = Math.max(need * HINT, base * 1.15);
    const hint = (p: number) => app.zoomHint(toward ? `Zooming toward <b>${esc(n.title)}</b>` : null, p);
    if (a < from) return scene.setPreview(null), hint(0);
    if (a < need) return scene.setPreview(n.id, (a - from) / (need - from)), hint((a - from) / (need - from));
    app.zoomHint(null);
    scene.completePreview(n.id);
    state.cooldown = now + 1300;
    app.toast(`Inside: ${n.title}`);
    scene.levelChanged();
    app.setFocus(n.id, { anchor: true });
    scene.fitIds(new Set([n.id])); // one motion: the camera flies to the opened block while the layout opens it
    later(app, () => settle(app), 1250);
}

/**
 * The share of the map a block covers when the wheel has opened it and the camera has framed it (0.32–0.335 measured).
 * A parent gone up to is measured as if it had just been opened that way, so every level takes the same notches out
 * however far the camera already is. (Measured where it became the focus, each level's way out began ~1.8× farther
 * than the last: three levels up left the map a speck at the back of the screen.)
 */
const FRAMED = 0.33;
const AFTER_UP = 2; // a small parent closes at 0.3 × 2 = 0.6 of its size at the first look: two notches more

/** The first look after going up (the relayout has landed): the parent's way out, as if the wheel had just opened it. */
function measureAfterUp(app: App, a: number): void {
    const { state } = app;
    // a parent already small (it gets this first look only after the cooldown, the wheel going on) still takes a
    // couple of notches more: never a cascade of two levels
    if (state.upRef?.id === state.focus) {
        state.focusArea = Math.min(FRAMED, a * AFTER_UP);
        state.upDist = camDistance(app);
    }
    state.upRef = null;
}

/** Zooming out: the focus closes when it has shrunk below EXIT; before that, a hint says how close that is. */
function zoomOut(app: App, now: number): unknown {
    const { state, model, scene } = app;
    scene.setPreview(null);
    scene.steerZoom(null);
    if (!state.focus) return app.zoomHint(null);
    const a = scene.screenArea(state.focus);
    if (state.upRef) measureAfterUp(app, a);
    // never below the size the focus has at the farthest the camera goes (a fast pinch out may leave a level when its
    // parent is already small): there is always a way out
    const reach = a * (camDistance(app) / scene.controls.maxDistance) ** 2 * 1.1;
    const EXIT = Math.min(0.12, Math.max((state.focusArea ?? 0.3) * EXIT_SHARE, reach));
    const f = model.nodes.get(state.focus)!;
    const up = app.upOf(f.id);
    // the last level up: the overview comes when the camera is as far as the resting view, whatever the focus's size
    const home = !up && atHome(app);
    if (!home && a > EXIT * 2.2) return app.zoomHint(null);
    if (!home && a > EXIT) return app.zoomHint(`Zoom out more to leave for <b>${esc(up ? up.title : 'the whole system')}</b>`, (EXIT * 2.2 - a) / (EXIT * 1.2));
    goUp(app, f, up, now);
}

/** The focus `f` closes: up to its parent, or to the overview when `up` is null. */
function goUp(app: App, f: ViewNode, up: ViewNode | null, now: number): void {
    const { state, scene } = app;
    app.zoomHint(null);
    state.cooldown = now + 900;
    app.toast(up ? `Up: ${up.title}` : 'The whole system');
    scene.levelChanged();
    scene.anchor = f.id;
    state.focus = up ? up.id : null;
    state.selected = { type: 'node', id: f.id };
    // The parent's way out is measured right after going up. Not on screen now (the relayout that folds the child
    // shrinks it over ENTER_MS, and the wheel keeps zooming meanwhile): zoomOut's first look after the relayout does it.
    // (Measuring mid-relayout, floored at 0.15, let the next level go after 1–3 notches: the cascade of two levels per pinch.)
    state.upRef = up ? { id: up.id } : null;
    const upArea = up ? scene.screenArea(up.id) : 0; // the parent as an open board, before it closes around the child
    app.relayout();
    // going up the camera stays with the wheel (framing the parent would often pull it forward, against the zoom),
    // unless the parent is a speck (entered from a search or a link, or a fast pinch): then it is framed, as the
    // wheel frames a block it opens; the overview lands on the resting view
    if (!up) toRest(app);
    else if (upArea < SPECK) pullIn(app, up.id);
    // after going up the plain threshold applies: «grow twice» only guards against falling through right after going in
    // (the parent's way out is set by measureAfterUp, after this settle)
    later(app, () => (app.settle(), (state.baseAreas = null)), 560);
}

const HOME = 1; // the overview comes at the resting view's distance (then lands on it)

/** Two notches of the wheel, as a camera distance ratio (each notch ×1.13). */
const TWO_NOTCHES = 1.28;

/** Whether the camera is as far as the resting view of the map as it is laid out now, and (after going up) two notches
 *  past where the focus was first looked at: the overview is never a cascade from the level below. */
function atHome(app: App): boolean {
    const rest = app.scene.fitDistance();
    const d = camDistance(app);
    return !!rest && d >= rest.dist * HOME && d >= (app.state.upDist ?? 0) * TWO_NOTCHES;
}

const SPECK = 0.06; // going up, a parent under this share of the map is framed (wheel-out leaves it at 0.17–0.4)

/** Frames the parent just gone up to, the wheel's outward speed dropped first (the flight would carry on outward). */
function pullIn(app: App, id: ElementId): void {
    const { scene } = app;
    scene.camVel.c.set(0, 0, 0);
    scene.camVel.t.set(0, 0, 0);
    scene.fitIds(new Set([id]));
}

/** Back at the overview: the camera lands on the resting view. When that is nearer, the wheel's outward speed is dropped
 *  first, or the flight would carry on outward before turning back. */
function toRest(app: App): void {
    const { scene } = app;
    const rest = scene.fitDistance();
    if (!rest) return;
    if (rest.dist < camDistance(app)) {
        scene.camVel.c.set(0, 0, 0);
        scene.camVel.t.set(0, 0, 0);
    }
    scene.fitAll();
}

/** Camera to orbit target: a block's share of the screen goes as the inverse square of it. */
function camDistance(app: App): number {
    return app.scene.camera.position.distanceTo(app.scene.controls.target);
}

/**
 * The board the cursor is on, when it lies outside the focus (neither inside it nor around it): the board a leaf
 * stands on, else the deepest open board under the cursor. Null when the cursor is on the focus or its context.
 */
export function switchTarget(app: App, under: ViewNode[], top: ViewNode | undefined): ViewNode | null | undefined {
    const { state, model } = app;
    if (!state.focus) return null;
    const lvl = (c: ViewNode) => ancestors(model, c.id).length;
    let c: ViewNode | null | undefined = top && !top.children.length && top.parent ? model.nodes.get(top.parent) : null;
    c ??= under.filter((u) => state.expanded.has(u.id)).sort((a, b) => lvl(b) - lvl(a))[0];
    const f = c && focusOf(model, c.id);
    if (!f || app.restSet().has(f) || inside(model, f, state.focus) || inside(model, state.focus, f)) return null;
    return model.nodes.get(f);
}

const SWITCH_MS = 450;

/** Zooming in over board `c` outside the focus: the ring fills for SWITCH_MS, then the focus moves to it in place. */
export function armSwitch(app: App, c: ViewNode, now: number): unknown {
    const { state, scene } = app;
    const sw = state.switching;
    if (!sw || sw.id !== c.id || now - sw.last! > 300) state.switching = { id: c.id, t0: now };
    state.switching!.last = now;
    const p = (now - state.switching!.t0) / SWITCH_MS;
    if (p < 1) return scene.setPreview(c.id, Math.max(0.1, p), 'switch');
    state.switching = null;
    scene.completePreview(c.id, 'switch');
    state.cooldown = now + 1300;
    app.toast(`Focus: ${c.title}`);
    scene.levelChanged();
    app.setFocus(c.id, { anchor: true }); // it stays where it is on screen; the zoom goes on
    later(app, () => settle(app), 1250);
}

// ---------- path ----------
export function startPath(app: App, id: ElementId, method: MethodName): void {
    const { state, model, scene } = app;
    const n = model.nodes.get(id);
    if (!n) return;
    const steps = method === '*' ? traceNode(model, id) : trace(model, id, method);
    const ep = method !== '*' && n.endpoints?.find((e) => e.handler === method);
    const callers = ep
        ? model.edges.filter((e) => e.endpoint === ep.id).flatMap((e) => (e.kind === 'rest' ? e.items.map((i) => (i.split(' ← ')[1] ?? model.nodes.get(e.from)?.title)!) : [model.nodes.get(e.from)?.title ?? e.from]))
        : [];
    state.all = false;
    state.path = { title: ep ? `${ep.method} ${ep.path}` : method === '*' ? `${n.title}: everything it calls` : `${n.title}.${method}()`, steps, callers, start: id, method };
    state.scenario = null;
    state.focus = null;
    state.selected = null;
    app.relayout();
    later(app, () => scene.fitIds(app.pathIds()), 500);
}

export function pathIds(app: App): Set<ElementId> {
    const { state, model } = app;
    return new Set([state.path!.start, ...state.path!.steps.flatMap((s) => [s.from, s.to])].map((x) => visibleAncestor(model, state.expanded, x).id));
}

export function closePath(app: App): void {
    const { state, model } = app;
    const start = state.path?.start;
    state.path = null;
    if (!start) return app.relayout();
    app.setFocus(model.nodes.get(start)!.parent, { select: false });
    app.select({ type: 'node', id: start });
}

/** Show a thing: go into the block that holds it and select it. */
export function goTo(app: App, id: ElementId): void {
    const { model, scene } = app;
    const n = model.nodes.get(id);
    if (!n) return;
    app.setFocus(n.children.length ? id : n.parent, { select: false });
    app.select({ type: 'node', id });
    later(app, () => scene.flyTo(id), 560);
}

/** Client layer ⇄ technical overview: what is open at rest. */
export function setView(app: App, v: string): void {
    const { state } = app;
    state.view = v === 'tech' ? 'tech' : 'client';
    state.focus = null;
    state.path = null;
    state.selected = null;
    app.relayout();
    later(app, () => app.frameFocus(), 500);
    later(app, () => settle(app), 1250);
}
