// Labels: their measured size, the level of detail and the placement of every name on the map, the lines they keep off.
import * as THREE from 'three';
import { edgeCount } from './scene-edges.ts';
import type { MapScene } from './scene.ts';
import type { Candidate, ChipView, EdgeView, LabelEl, LabelOption, LabelSize, NodeView, PlateView } from './scene-types.ts';
import type { SceneView, ScreenPoint } from '../../types/scene.ts';
import type { ElementId } from '../../types/spec.d.ts';

/** Spots around an anchor for a label of size `sz`, nearest first: on it, above/below, beside, then one step further. */
function around(sz: LabelSize): number[][] {
    const out = [[0, 0]];
    for (const k of [1, 2]) {
        const dx = (sz.w / 2 + 10) * k, dy = (sz.h / 2 + 8) * k;
        out.push([0, -dy], [0, dy], [-dx, -dy / k], [dx, -dy / k], [-dx, dy / k], [dx, dy / k]);
    }
    return out;
}

/** An envelope opens (shows its fields) once its relation is at least this long on screen, in px. */
const ENVELOPE_OPEN = 380;

/** Does segment [x0, y0, x1, y1] touch rectangle [l, t, r, b] (Liang–Barsky)? */
function segHitsRect([x0, y0, x1, y1]: number[], [l, t, r, b]: number[]): boolean {
    let u0 = 0, u1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    for (const [pp, qq] of [[-dx, x0 - l], [dx, r - x0], [-dy, y0 - t], [dy, b - y0]]) {
        if (pp === 0) {
            if (qq < 0) return false;
            continue;
        }
        const u = qq / pp;
        if (pp < 0) u0 = Math.max(u0, u);
        else u1 = Math.min(u1, u);
        if (u0 > u1) return false;
    }
    return true;
}

/**
 * Real size of a label in px for a class list (measured once per content, class and font load). A size not known
 * yet is queued and a zero size returned for now: cullLabels measures the whole queue in one layout pass
 * (`measureQueued`) and places the labels again — one reflow per frame, not one per new label.
 */
export function size(scene: MapScene, el: LabelEl, cls: string): LabelSize {
    const key = `${scene.mgen}|${cls}|${el.dataset.step ?? ''}`;
    el._m ??= new Map();
    const sz = el._m.get(key);
    if (sz) return sz;
    const pending = { w: 0, h: 0 };
    el._m.set(key, pending);
    scene.toMeasure.push({ el, cls, key, pending });
    return pending;
}

/** Measures every queued label: twins are written first, then all are read — a single forced layout. */
export function measureQueued(scene: MapScene): void {
    const q = scene.toMeasure;
    if (!q.length) return;
    scene.toMeasure = [];
    const frag = document.createDocumentFragment();
    const twins = q.map(({ el, cls }) => {
        const d = document.createElement('div');
        d.className = cls;
        d.style.cssText = 'position:absolute;left:0;top:0';
        d.innerHTML = el.innerHTML;
        if (el.dataset.step) d.dataset.step = el.dataset.step;
        frag.appendChild(d);
        return d;
    });
    scene.measureEl.appendChild(frag);
    twins.forEach((d, i) => Object.assign(q[i].pending, { w: d.offsetWidth, h: d.offsetHeight }));
    scene.measureEl.replaceChildren();
}

/** What one pass of `cullLabels` works with: the camera and the map's size, the temporaries, and what `collectLabels` found. */
interface LabelPass {
    cam: THREE.PerspectiveCamera;
    W: number;
    H: number;
    vw: SceneView;
    /** The bars over the map (focus, legend, scenario step, hints) in map px: taken space. */
    bars: number[][];
    box: THREE.Box3;
    a: THREE.Vector3;
    b: THREE.Vector3;
    p: THREE.Vector3;
    q: THREE.Vector3;
    toScreen: (v: THREE.Vector3) => ScreenPoint;
    inView: number;
    cands: Candidate[];
    /** Screen boxes of the blocks: an envelope would rather not cover one. */
    bodies: number[][];
    /** The top face of every block on screen, shrunk a little toward its middle: no other block's name covers it. */
    faces: { id: ElementId; box: number[]; segs: number[][]; c: ScreenPoint }[];
    /** The middle half (each way) of every block's screen box: where the pointer picks that block over a name on it. */
    cores: { id: ElementId; r: number[] }[];
}

/**
 * Level of detail and placement of every label. A label is shown only if its thing is in frame and big
 * enough on screen, and only where it overlaps no label placed before it. Candidates go by importance — selected
 * and focus, the top level, lit things, the scenario step's relation and its envelopes, locks, other names, other
 * relations, layer names last — each at its real size. One that does not fit tries its short form and, for
 * envelopes and layer names, a few nearby spots; otherwise it is hidden. Names of the client layer stand above
 * their tile; layer names also keep off the lines.
 * Three parts: `labelPass` (the camera and the bars), `collectLabels` (one candidate per thing, with its spots),
 * `placeLabels` (the first spot that is free, in order of importance).
 */
export function cullLabels(scene: MapScene): void {
    const pass = labelPass(scene);
    collectLabels(scene, pass);
    if (scene.toMeasure.length) {
        measureQueued(scene);
        collectLabels(scene, pass);
    }
    pass.cands.sort((x, y) => y.prio - x.prio);
    const { shown, eShown, envShown } = placeLabels(scene, pass);
    scene.stats = { nodes: scene.nodes.size, inView: pass.inView, labels: shown, edges: scene.edges.size, edgeLabels: eShown, envelopes: envShown };
    scene.handlers.stats?.(scene.stats);
}

function labelPass(scene: MapScene): LabelPass {
    const cam = scene.camera;
    cam.updateMatrixWorld();
    scene.frustum.setFromProjectionMatrix(scene.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    // the bars over the map (focus, legend, scenario step, hints) are taken space; read before anything is written
    // this frame, so the read finds the layout clean
    scene.rect = null; // the page around an embedded map may have moved it since the last frame
    const st = scene.stageRect();
    const bars: number[][] = [];
    for (const el of scene.container.querySelectorAll<HTMLElement>(':scope > #focusbar, :scope > #legend, :scope > #stepbar, :scope > #zoomhint')) {
        if (el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (r.width) bars.push([r.left - st.left, r.top - st.top, r.right - st.left, r.bottom - st.top]);
    }
    const W = st.width, H = st.height;
    const box = new THREE.Box3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
    const toScreen = (v: THREE.Vector3): ScreenPoint => ({ x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H });
    const vw: SceneView = scene.view ?? {};
    return { cam, W, H, vw, bars, box, a, b, p, q, toScreen, inView: 0, cands: [], bodies: [], faces: [], cores: [] };
}

/** A label's class list with one form class on or off; kept per label until its classes change. */
function formClass(el: LabelEl, add: string[], drop: string[]): string {
    if (el._cn !== el.className) {
        el._cn = el.className;
        el._cl = new Map();
    }
    const k = `${add}|${drop}`;
    let v = el._cl!.get(k);
    if (v === undefined) el._cl!.set(k, (v = [...el.className.split(/\s+/).filter((c) => c && !drop.includes(c)), ...add].join(' ')));
    return v;
}
function shift(el: LabelEl, dx: number, dy: number): void {
    const t = dx || dy ? `${Math.round(dx)}px ${Math.round(dy)}px` : '';
    if (el._t !== t) {
        el._t = t;
        el.style.translate = t;
    }
}
/** The screen top of a tile's upper face within [L, R]: a name above its tile ends there. */
function tileTop(pass: LabelPass, bx: THREE.Box3, L: number, R: number): number {
    const { cam, q, toScreen } = pass;
    const c = [[bx.min.x, bx.min.z], [bx.max.x, bx.min.z], [bx.max.x, bx.max.z], [bx.min.x, bx.max.z]].map(([x, z]) => toScreen(q.set(x, bx.max.y, z).project(cam)));
    let top = Infinity;
    for (let i = 0; i < 4; i++) {
        const P = c[i], Q = c[(i + 1) % 4];
        const x0 = Math.max(L, Math.min(P.x, Q.x)), x1 = Math.min(R, Math.max(P.x, Q.x));
        if (x0 > x1) continue;
        const yAt = (x: number) => (Math.abs(Q.x - P.x) < 1e-6 ? Math.min(P.y, Q.y) : P.y + ((Q.y - P.y) * (x - P.x)) / (Q.x - P.x));
        top = Math.min(top, yAt(x0), yAt(x1));
    }
    return top;
}

/** The candidates; a label met for the first time is measured (in one batch) and the candidates built again. */
function collectLabels(scene: MapScene, pass: LabelPass): void {
    pass.inView = 0;
    pass.cands = [];
    pass.bodies = []; // screen boxes of the blocks: an envelope would rather not cover one
    pass.faces = [];
    pass.cores = [];
    for (const [id, v] of scene.nodes) nodeCandidate(scene, pass, id, v);
    for (const [id, v] of scene.edges) edgeCandidate(scene, pass, id, v);
    for (const ch of scene.chips.values()) chipCandidate(scene, pass, ch);
    // layer names come last: they give way to any other name and move along their edge off the lines
    for (const pl of scene.plates) plateCandidate(scene, pass, pl);
}

// ---------- the names of blocks ----------
/** What a block's name is placed by: its size on screen, plate or block, and why it is (or is not) named whatever its size. */
interface NodeFacts {
    px: number;
    plate: boolean | undefined;
    forced: unknown;
    essential: unknown;
    /** Something is selected and this is not what it is about: named dimmed (`.unlit`), after the lit ones. */
    unlit: boolean;
}

/** The screen box of the block's body (the box `pass.box` holds): an envelope would rather not cover it. */
function bodyRect(pass: LabelPass): number[] {
    const { box, cam, q, toScreen } = pass;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const cx of [box.min.x, box.max.x]) for (const cy of [box.min.y, box.max.y]) for (const cz of [box.min.z, box.max.z]) {
        const sp = toScreen(q.set(cx, cy, cz).project(cam));
        x0 = Math.min(x0, sp.x);
        y0 = Math.min(y0, sp.y);
        x1 = Math.max(x1, sp.x);
        y1 = Math.max(y1, sp.y);
    }
    return [x0, y0, x1, y1];
}

/** The top face of the block's body (the box `pass.box` holds) on screen, shrunk by a fifth toward its middle. */
function topFace(pass: LabelPass, id: ElementId): LabelPass['faces'][number] {
    const { box: bx, cam, q, toScreen } = pass;
    const pts = [[bx.min.x, bx.min.z], [bx.max.x, bx.min.z], [bx.max.x, bx.max.z], [bx.min.x, bx.max.z]].map(([x, z]) => toScreen(q.set(x, bx.max.y, z).project(cam)));
    const c = { x: pts.reduce((a, p) => a + p.x, 0) / 4, y: pts.reduce((a, p) => a + p.y, 0) / 4 };
    const k = pts.map((p) => ({ x: c.x + (p.x - c.x) * 0.8, y: c.y + (p.y - c.y) * 0.8 }));
    const segs = k.map((p, i) => [p.x, p.y, k[(i + 1) % 4].x, k[(i + 1) % 4].y]);
    const xs = k.map((p) => p.x), ys = k.map((p) => p.y);
    return { id, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], segs, c };
}

/** Is the block in frame and big enough to be named? Hides its name and returns null when not; else what it is placed by. */
function nodeFacts(scene: MapScene, pass: LabelPass, id: ElementId, v: NodeView): NodeFacts | null {
    const { cam, vw, W, box, a, b, p } = pass;
    box.setFromObject(v.body, false);
    if (!scene.frustum.intersectsBox(box)) {
        v.label.visible = false;
        return null;
    }
    pass.inView++;
    a.set(box.min.x, box.max.y, (box.min.z + box.max.z) / 2).project(cam);
    b.set(box.max.x, box.max.y, (box.min.z + box.max.z) / 2).project(cam);
    const px = (Math.abs(a.x - b.x) * W) / 2;
    v.detail.visible = px > 46 && !v.ghost; // pins, fins, slots and traces only when they can be seen
    p.copy(v.label.position).project(cam);
    if (p.z > 1) {
        v.label.visible = false;
        return null;
    }
    const plate = v.node._plate;
    if (v.ghost) {
        v.label.visible = false;
        return null;
    }
    if (!plate) {
        const r = bodyRect(pass);
        pass.bodies.push(r);
        pass.faces.push(topFace(pass, id));
        const qx = (r[2] - r[0]) / 4, qy = (r[3] - r[1]) / 4;
        pass.cores.push({ id, r: [r[0] + qx, r[1] + qy, r[2] - qx, r[3] - qy] });
    }
    const n = v.node;
    const forced = scene.selected === id || vw.focus === id || vw.steps?.has(id) || (vw.lit && vw.lit.has(id) && !plate);
    // while something is selected, what it is about is labelled first; the rest keep their names, dimmed (.unlit),
    // competing for room after the lit ones — the picture around a selection stays readable
    const unlit = !!vw.lit && !vw.soft && !forced && !plate;
    // what names the picture: the top two levels, the parts of the focus; they are labelled even when small
    const essential = !n.context && (n.depth! <= 1 || (vw.focus && n.parent === vw.focus));
    const min = plate ? 70 : 30;
    if (!forced && !essential && px < min) {
        v.label.visible = false;
        return null;
    }
    return { px, plate, forced, essential, unlit };
}

/** A block's name: where it can stand (its form, at its real size), by how important it is. */
function nodeCandidate(scene: MapScene, pass: LabelPass, id: ElementId, v: NodeView): void {
    const f = nodeFacts(scene, pass, id, v);
    if (!f) return;
    const { vw, box, p } = pass;
    const { px, plate, forced, unlit } = f;
    const n = v.node;
    const big = !n.parent && n.type !== 'app' && n.type !== 'datastore';
    const mini = !forced && px < (plate ? 170 : big ? 60 : 110);
    const s = pass.toScreen(p);
    const el = v.label.element;
    const bx = plate ? null : box.clone(); // a name stands above its tile, or on it in a dense grid
    const pinned = !unlit && (scene.selected === id || vw.focus === id || n.depth === 0);
    const opts = bx ? tileNameOptions(scene, pass, { el, s, bx, mini, id, pinned }) : nodeOptions(scene, pass, { el, s, bx, plate, mini });
    pass.cands.push({ obj: v.label, opts, prio: pinned ? 5e6 : nodePrio(n, f) });
}

/**
 * The spots of a tile's name, in order. In a dense grid a name above its tile lies over the tile behind and reads as
 * that one's (and takes its pointer): first the spot above if it covers no other block's face, then the tile's own
 * face, then the spots of old that keep off every other block's middle (a name there would give that block's card,
 * click and double-click); only a pinned name, which never disappears, may then stand anywhere (the block under its
 * text wins the pointer there). A pinned name (an app of the open system) may also stand a line or two higher over
 * its tile (blocks in a row are narrower than their names).
 */
function tileNameOptions(scene: MapScene, pass: LabelPass, { el, s, bx, mini, id, pinned }: { el: LabelEl; s: ScreenPoint; bx: THREE.Box3; mini: boolean; id: ElementId; pinned: boolean }): LabelOption[] {
    const opts = nodeOptions(scene, pass, { el, s, bx, plate: false, mini });
    const clear = [...opts.map((o) => ({ ...o, clearOf: id })), ...onTileOptions(scene, pass, { el, s, bx, mini, id })];
    if (pinned) raisedOptions(opts, el);
    return [...clear, ...opts.map((o) => ({ ...o, clearOfCore: id })), ...(pinned ? opts : [])];
}

/** How important a block's name is (not pinned): lit, the essentials, open containers, dimmed names, the rest. */
function nodePrio(n: NodeView['node'], { px, plate, forced, essential, unlit }: NodeFacts): number {
    if (forced) return 4e6 + px;
    if (unlit) return 1.5e6 + (essential ? 4e5 : 0) + px;
    if (essential) return 3e6 + n.degree * 100 + (2 - n.depth!) * 1e5;
    return (plate ? 2e6 : 1e6) + px;
}

/** The spots of a block's name: the full form and the short one (or the short one alone), each at its real size. */
function nodeOptions(scene: MapScene, pass: LabelPass, { el, s, bx, plate, mini }: { el: LabelEl; s: ScreenPoint; bx: THREE.Box3 | null; plate: boolean | undefined; mini: boolean }): LabelOption[] {
    return (mini ? [true] : [false, true]).map((m): LabelOption => {
        const sz = size(scene, el, formClass(el, m ? ['mini'] : [], ['mini']));
        if (plate) return { rect: [s.x, s.y, s.x + sz.w, s.y + sz.h], apply: () => (el.classList.toggle('mini', m), shift(el, 0, 0)) };
        const L = s.x - sz.w / 2;
        const lift = bx ? Math.max(0, s.y - (tileTop(pass, bx, L, L + sz.w) - 4)) : 0;
        return { rect: [L, s.y - sz.h - lift, L + sz.w, s.y - lift], apply: () => (el.classList.toggle('mini', m), shift(el, 0, -lift)) };
    });
}

/** A tile's name on the tile's own face (full form, then short), centred on it: it cannot be read as a neighbour's. */
function onTileOptions(scene: MapScene, pass: LabelPass, { el, s, bx, mini, id }: { el: LabelEl; s: ScreenPoint; bx: THREE.Box3; mini: boolean; id: ElementId }): LabelOption[] {
    const c = pass.toScreen(pass.q.set((bx.min.x + bx.max.x) / 2, bx.max.y, (bx.min.z + bx.max.z) / 2).project(pass.cam));
    return (mini ? [true] : [false, true]).map((m): LabelOption => {
        const sz = size(scene, el, formClass(el, m ? ['mini'] : [], ['mini']));
        const dx = c.x - s.x, dy = c.y + sz.h / 2 - s.y;
        return { rect: [c.x - sz.w / 2, c.y - sz.h / 2, c.x + sz.w / 2, c.y + sz.h / 2], apply: () => (el.classList.toggle('mini', m), shift(el, dx, dy)), clearOf: id };
    });
}

/** Adds, for each spot, the same one a line and two lines higher. */
function raisedOptions(opts: LabelOption[], el: LabelEl): void {
    for (const base of [...opts]) for (const k of [1, 2]) {
        const h = base.rect[3] - base.rect[1] + 3;
        const r = [base.rect[0], base.rect[1] - h * k, base.rect[2], base.rect[3] - h * k];
        opts.push({ rect: r, apply: () => (base.apply!(), (el.style.translate = `0px ${Math.round(-h * k + (Number(String(el._t ?? '0px 0px').split(' ')[1]?.replace('px', '')) || 0))}px`), (el._t = el.style.translate)) });
    }
}

// ---------- the names of relations ----------
/** Where on its line a relation's name stands: the middle, or, for the step's or the selected relation, the nearest spot in frame. */
function edgeLabelT(pass: LabelPass, v: EdgeView, keep: boolean): number {
    const { cam, p } = pass;
    let t = 0.5;
    if (keep)
        for (const x of [0.5, 0.6, 0.4, 0.7, 0.3, 0.8, 0.2, 0.9, 0.1]) {
            p.copy(v.curve.getPointAt(x)).project(cam);
            if (p.z < 1 && Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.88) {
                t = x;
                break;
            }
        }
    return t;
}

/** A lock is shown on any relation long enough to carry it; other names only on long or lit relations. */
function edgeNameHidden(v: EdgeView, vw: SceneView, forced: unknown, len: number): unknown {
    // a hop of a routed relation (to the gateway, gateway → API) carries nothing of its own: named when lit only
    return v.edge.transit ? !forced : v.lock ? len < 30 || (vw.lit && !forced) : !forced && (len < 120 || vw.lit);
}

/** A relation's name: its spots (a pinned one may step aside from a crowded midpoint), by how important it is. */
function edgeCandidate(scene: MapScene, pass: LabelPass, id: string, v: EdgeView): void {
    const { cam, W, H, vw, p, q, toScreen } = pass;
    v.len = 0;
    if (v.hidden) {
        v.label.visible = false;
        return;
    }
    // the name of the step's or the selected relation slides along its line into the frame
    const keep = scene.selected === id || !!vw.edgeSteps?.has(id);
    const t = edgeLabelT(pass, v, keep);
    if (v.t !== t) {
        v.t = t;
        v.label.position.copy(v.curve.getPointAt(t));
    }
    p.copy(v.label.position).project(cam);
    const inFrame = p.z < 1 && Math.abs(p.x) < 1.02 && Math.abs(p.y) < 1.02;
    const forced = scene.selected === id || (vw.litEdges && vw.litEdges.has(id));
    const s0 = q.copy(v.curve.getPointAt(0.1)).project(cam), x0 = s0.x, y0 = s0.y;
    const s1 = q.copy(v.curve.getPointAt(0.9)).project(cam);
    const len = (v.len = Math.hypot(((x0 - s1.x) * W) / 2, ((y0 - s1.y) * H) / 2));
    const hide = edgeNameHidden(v, vw, forced, len);
    if (!inFrame || hide) {
        v.label.visible = false;
        return;
    }
    const s = toScreen(p);
    const el = v.label.element;
    const pinned = scene.selected === id || !!vw.edgeSteps?.has(id); // the relation of the scenario step keeps its number
    const opts: LabelOption[] = [];
    for (const only of [false, ...(v.lock ? [true] : [])]) {
        const sz = size(scene, el, formClass(el, only ? ['lockonly'] : [], ['lockonly']));
        // a pinned name may step aside from a crowded midpoint rather than disappear
        for (const [ox, oy] of pinned ? around(sz) : [[0, 0]])
            opts.push({ rect: [s.x - sz.w / 2 + ox, s.y - sz.h / 2 + oy, s.x + sz.w / 2 + ox, s.y + sz.h / 2 + oy], apply: () => (el.classList.toggle('lockonly', only), shift(el, ox, oy)) });
    }
    // at rest only the heaviest relations are labelled
    const prio = pinned ? 3.97e6 : v.lock ? 3.6e6 + len : forced ? 2.5e6 + len : edgeCount(v.edge) * 1000 + len;
    // in a dense picture a lock at rest is one more chip under the cap; lit, it is always named
    pass.cands.push({ obj: v.label, opts, rest: !forced && (!v.lock || scene.edges.size > 50), prio, edge: true });
}

// ---------- envelope chips ----------
/**
 * Where on its relation an envelope chip stands: on its own half of the line (request near the caller), as near its
 * usual spot as the frame allows (when only the other half is in frame — a line from far off screen — there); null when
 * no spot of the line is in frame.
 */
function chipT(pass: LabelPass, ch: ChipView): number | null {
    const { cam, p } = pass;
    const own = ch.side === 'request' ? [0.3, 0.25, 0.35, 0.2, 0.4, 0.15, 0.45, 0.1] : [0.7, 0.75, 0.65, 0.8, 0.6, 0.85, 0.55, 0.9];
    const ts = [...own, ...own.map((x) => 1 - x).reverse()];
    let t: number | null = null;
    for (const x of ts) {
        p.copy(ch.v.curve.getPointAt(x)).project(cam);
        if (p.z < 1 && Math.abs(p.x) < 0.88 && Math.abs(p.y) < 0.85) {
            t = x;
            break;
        }
    }
    return t;
}

/** An envelope: the name while the line is short on screen, the name and its fields once it is long (zoom). */
function chipCandidate(scene: MapScene, pass: LabelPass, ch: ChipView): void {
    const { p, toScreen } = pass;
    const v = ch.v;
    const t = chipT(pass, ch);
    if (v.hidden || !v.len || t === null) {
        ch.obj.visible = false;
        return;
    }
    if (ch.t !== t) {
        ch.t = t;
        ch.obj.position.copy(v.curve.getPointAt(t));
    }
    const s = toScreen(p);
    const el = ch.el;
    const forms = ch.hasFields && v.len >= ENVELOPE_OPEN ? [true, false] : [false];
    const opts: LabelOption[] = [];
    for (const open of forms) {
        const sz = size(scene, el, formClass(el, open ? ['open'] : [], ['open']));
        for (const [ox, oy] of around(sz))
            opts.push({ rect: [s.x - sz.w / 2 + ox, s.y - sz.h / 2 + oy, s.x + sz.w / 2 + ox, s.y + sz.h / 2 + oy], apply: () => (el.classList.toggle('open', open), shift(el, ox, oy)) });
    }
    // first a spot that covers no block, then any free spot
    const clear = opts.map((o) => ({ ...o, clearOfBodies: true }));
    pass.cands.push({ obj: ch.obj, opts: [...clear, ...opts], prio: 3.95e6 + (ch.side === 'request' ? 1 : 0), env: true });
}

// ---------- layer names ----------
/** A layer's name: a few spots along its front edge. */
function plateCandidate(scene: MapScene, pass: LabelPass, pl: PlateView): void {
    const { cam, q, toScreen } = pass;
    const el = pl.label.element;
    const sz = size(scene, el, el.className);
    const opts: LabelOption[] = [];
    for (const x of [Math.min(34, pl.p.w * 0.2), pl.p.w * 0.3, pl.p.w * 0.5, pl.p.w * 0.7, 8]) {
        const pos = new THREE.Vector3(-pl.p.w / 2 + x, pl.p.y, pl.p.d / 2);
        q.copy(pos).project(cam);
        if (q.z > 1) continue;
        const sc = toScreen(q);
        opts.push({ rect: [sc.x, sc.y, sc.x + sz.w, sc.y + sz.h], apply: () => pl.label.position.copy(pos), layerName: true });
    }
    pass.cands.push({ obj: pl.label, opts, prio: 1, layerName: true });
}

// ---------- placing ----------
/** For a candidate, the first of its spots that is free: inside the map, clear of what is placed, of the lines and of the blocks where it asks. */
function spotFinder(scene: MapScene, pass: LabelPass, placed: number[][]): (c: Candidate) => LabelOption | undefined {
    const { W, H, toScreen, bodies, faces, cores } = pass;
    const outside = (r: number[]) => r[0] < 4 || r[1] < 4 || r[2] > W - 4 || r[3] > H - 4;
    const overlaps = (r: number[]) => outside(r) || placed.some((o) => r[0] < o[2] + 3 && r[2] + 3 > o[0] && r[1] < o[3] + 2 && r[3] + 2 > o[1]);
    let segs: { box: number[]; list: number[][] }[] | null = null;
    const crossesLine = (r: number[]) => {
        segs ??= lineSegments(scene, toScreen);
        const R = [r[0] - 4, r[1] - 3, r[2] + 4, r[3] + 3];
        // a line's box first: only the few lines near the name have their segments tested
        return segs.some(({ box: b, list }) => b[0] <= R[2] && b[2] >= R[0] && b[1] <= R[3] && b[3] >= R[1] && list.some((sg) => segHitsRect(sg, R)));
    };
    const hit = (r: number[], o: number[]) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1];
    const covers = (r: number[]) => bodies.some((o) => hit(r, o));
    const inRect = (p: ScreenPoint, r: number[]) => p.x > r[0] && p.x < r[2] && p.y > r[1] && p.y < r[3];
    const coversCore = (r: number[], id: ElementId) => cores.some((o) => o.id !== id && hit(r, o.r));
    const coversOther = (r: number[], id: ElementId) => coversCore(r, id) || faces.some((f) => f.id !== id && hit(r, f.box) && (inRect(f.c, r) || f.segs.some((sg) => segHitsRect(sg, r))));
    const blocked = (x: LabelOption) => (x.clearOf && coversOther(x.rect, x.clearOf)) || (x.clearOfCore && coversCore(x.rect, x.clearOfCore));
    return (c) => c.opts.find((x) => !overlaps(x.rect) && !(x.layerName && crossesLine(x.rect)) && !(x.clearOfBodies && covers(x.rect)) && !blocked(x));
}

/** In order of importance, each candidate takes its first free spot or is hidden; how many of each kind were named. */
function placeLabels(scene: MapScene, pass: LabelPass): { shown: number; eShown: number; envShown: number } {
    const { vw, bars, cands } = pass;
    const placed = [...bars];
    const spot = spotFinder(scene, pass, placed);
    let shown = 0, eShown = 0, restEdges = 0, envShown = 0;
    const restCap = scene.cinema ? 0 : vw.focus ? (scene.edges.size > 50 ? 10 : 20) : 8; // the cinema names only what the step is about
    for (const c of cands) {
        const o = placed.length > 260 || (c.edge && c.rest && restEdges >= restCap) ? null : spot(c);
        if (!o) {
            c.obj.visible = false;
            continue;
        }
        placed.push(o.rect);
        c.obj.visible = true;
        o.apply?.();
        (c.obj.element as LabelEl)._r = o.rect; // where the label was placed (debug: compare with its DOM box)
        if (c.layerName) continue;
        if (c.env) envShown++;
        else if (c.edge) {
            eShown++;
            if (c.rest) restEdges++;
        } else shown++;
    }
    return { shown, eShown, envShown };
}

/** Screen segments of the drawn lines (for names that must not sit on a line), per line with its screen box. */
export function lineSegments(scene: MapScene, toScreen: (v: THREE.Vector3) => ScreenPoint): { box: number[]; list: number[][] }[] {
    const out: { box: number[]; list: number[][] }[] = [];
    const q = new THREE.Vector3();
    for (const v of scene.edges.values()) {
        if (v.hidden || !v.tube.visible || v.mat.opacity < 0.04) continue;
        const list: number[][] = [];
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        let prev: ScreenPoint | null = null;
        for (const pt of v.pts) {
            q.copy(pt).project(scene.camera);
            if (q.z > 1) {
                prev = null;
                continue;
            }
            const s = toScreen(q);
            if (s.x < box[0]) box[0] = s.x;
            if (s.y < box[1]) box[1] = s.y;
            if (s.x > box[2]) box[2] = s.x;
            if (s.y > box[3]) box[3] = s.y;
            if (prev) list.push([prev.x, prev.y, s.x, s.y]);
            prev = s;
        }
        if (list.length) out.push({ box, list });
    }
    return out;
}
