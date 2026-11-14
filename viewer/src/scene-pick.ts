// The pointer and the screen geometry: what is under a point, where a block is on screen, the «go inside» ring.
import * as THREE from 'three';
import { wheelClassifier } from './input.ts';
import { later, cancel } from './dom.ts';
import type { MapScene } from './scene.ts';
import type { NodeView, PickEvent } from './scene-types.ts';
import type { Box } from './card-aim.ts';
import type { Hit, ScreenPoint } from '../../types/scene.ts';
import type { ElementId } from '../../types/spec.d.ts';

const TB = new THREE.Box3(), TV = new THREE.Vector3(), TV2 = new THREE.Vector3(); // temporaries of the screen-space queries

// ---------- pointer ----------
/**
 * Look again at where the mouse rests (main.ts, when the hover card hides; scene-frame.ts, when the camera comes to
 * rest): a card that moves or hides, a wheel zoom or a flight, changes what is under a pointer that did not move, and
 * no pointer event says so — the hover stayed on a block passed on the way (or on the one the camera moved away)
 * although the pointer rested on another, until the next move.
 */
export function rehover(scene: MapScene): void {
    const at = scene.pointerAt;
    if (!at || !scene.labels.domElement.contains(scene.root.elementFromPoint(at.x, at.y))) return;
    const hit = pickAt(scene, at.x, at.y);
    scene.handlers.hover(hit, at);
    scene.labels.domElement.style.cursor = hit ? 'pointer' : 'grab';
}

export function bindPointer(scene: MapScene): void {
    const el = scene.labels.domElement;
    const on = { signal: scene.signal };
    let down: { x: number; y: number; target: EventTarget | null; touch: boolean } | null = null;
    let last = 0, trail = 0;
    // the controls capture the pointer on press, so the release lands on the layer: the press says what was clicked
    el.addEventListener('pointerdown', (e) => ((down = { x: e.clientX, y: e.clientY, target: e.target, touch: e.pointerType !== 'mouse' }), (scene.controls.floor = null)), on);
    el.addEventListener('pointermove', (e) => {
        const now = performance.now();
        const fl = scene.controls.floor;
        if (fl && Math.hypot(e.clientX - fl.x, e.clientY - fl.y) > 24) scene.controls.floor = null; // somewhere else now
        cancel(scene, trail);
        // throttled, but the place where the pointer stops is always looked at
        if (now - last < 40) {
            const { clientX, clientY, buttons } = e;
            trail = later(scene, () => {
                if (!el.contains(scene.root.elementFromPoint(clientX, clientY))) return; // it stopped over a card or a bar
                last = performance.now();
                const hit = buttons ? null : pickAt(scene, clientX, clientY);
                scene.handlers.hover(hit, { x: clientX, y: clientY });
                el.style.cursor = hit ? 'pointer' : 'grab';
            }, 45);
            return;
        }
        last = now;
        const hit = e.buttons ? null : pick(scene, e);
        scene.handlers.hover(hit, { x: e.clientX, y: e.clientY });
        el.style.cursor = hit ? 'pointer' : 'grab';
    }, on);
    // a trailing pick still pending when the pointer leaves for a card runs anyway: it hands the card to the block
    // last seen here, which moves the card away from a pointer heading for a block under it (click-fix: a click at a
    // block's centre never lands on a card); rehover then looks where the pointer really rests
    el.addEventListener('pointerleave', () => scene.handlers.hover(null), on);
    // where the mouse is, over the map or not (rehover looks there)
    document.addEventListener('pointermove', (e) => (scene.pointerAt = e.pointerType === 'mouse' ? { x: e.clientX, y: e.clientY } : null), { capture: true, passive: true, signal: scene.signal });
    // which buttons are held: the re-pick when the camera rests (scene-frame.ts noticeRest) waits for a drag to end
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel'] as const) document.addEventListener(t, (e) => (scene.pointerButtons = t === 'pointercancel' ? 0 : e.buttons), { capture: true, passive: true, signal: scene.signal });
    // the one wheel classifier (AD-15). Capture phase: it runs before the controls' own wheel listener, so a
    // two-finger pan can stop the zoom. Zoom and pinch: remember where and which way; the frame loop asks the app
    // while the camera moves.
    const classify = wheelClassifier();
    el.addEventListener('wheel', (e) => {
        const now = performance.now();
        const kind = classify(e, e.timeStamp, scene.controls._controlActive);
        // a pinch (ctrlKey wheel) never zooms the page, whatever the map does with it: the rest of a gesture that
        // changed level, a pinch while dragging, during a flight
        if (e.ctrlKey) e.preventDefault();
        if (kind === 'pinch' && scene.controls.limitPinch.held(e.timeStamp)) return e.stopImmediatePropagation(); // the rest of a gesture that changed level
        if (kind === 'pan') {
            e.preventDefault();
            e.stopImmediatePropagation();
            scene.track = scene.drift = scene.controls.floor = null; // the person takes the camera
            scene.controls.pan(-e.deltaX, -e.deltaY);
            scene.controls.update();
            scene.handlers.cameraStart?.();
            return;
        }
        // during a flight the controls ignore the wheel (enableZoom off) and would not stop a pinch from zooming the page
        if (scene.cam) e.preventDefault();
        if (e.deltaY !== 0) scene.lastWheel = { t: now, dir: e.deltaY < 0 ? 'in' : 'out', x: e.clientX, y: e.clientY };
    }, { passive: false, capture: true, signal: scene.signal });
    el.addEventListener('click', (e) => {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
        scene.handlers.click(pick(scene, { clientX: e.clientX, clientY: e.clientY, target: down?.target ?? e.target }), { x: e.clientX, y: e.clientY, touch: !!down?.touch });
    }, on);
    // the same pick as the hover and the click (a name over another block's middle gives that block), from the press
    el.addEventListener('dblclick', (e) => {
        const hit = pick(scene, { clientX: e.clientX, clientY: e.clientY, target: down?.target ?? e.target }, true);
        if (hit?.type === 'node') scene.handlers.toggle(hit.id);
    }, on);
}

/** What is under a screen point: a node or an edge. */
export function pickAt(scene: MapScene, x: number, y: number, nodesOnly = false): Hit | null {
    return pick(scene, { clientX: x, clientY: y, target: scene.root.elementFromPoint(x, y) ?? scene.labels.domElement }, nodesOnly);
}

/**
 * Bounds of a node's body on screen in normalized device coordinates, and whether a corner is behind the camera.
 * Reuses one box, one vector and `out` (called for every block several times a second while the wheel moves).
 */
export function ndcRect(scene: MapScene, v: Pick<NodeView, 'body'>, out = scene.rectTmp): MapScene['rectTmp'] {
    TB.setFromObject(v.body, false);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
    for (let i = 0; i < 8; i++) {
        TV.set(i & 1 ? TB.max.x : TB.min.x, i & 2 ? TB.max.y : TB.min.y, i & 4 ? TB.max.z : TB.min.z).project(scene.camera);
        if (TV.z > 1) behind = true;
        if (TV.x < x0) x0 = TV.x;
        if (TV.x > x1) x1 = TV.x;
        if (TV.y < y0) y0 = TV.y;
        if (TV.y > y1) y1 = TV.y;
    }
    out.x0 = x0;
    out.x1 = x1;
    out.y0 = y0;
    out.y1 = y1;
    out.behind = behind;
    return out;
}

/** Share of the map a node covers on screen, 0…1 (1 when the camera is inside or right at it). */
export function screenArea(scene: MapScene, id: ElementId): number {
    const v = scene.nodes.get(id);
    if (!v) return 0;
    const r = ndcRect(scene, v);
    if (r.behind) return 1;
    const x0 = Math.max(-1, r.x0), x1 = Math.min(1, r.x1), y0 = Math.max(-1, r.y0), y1 = Math.min(1, r.y1);
    return x1 > x0 && y1 > y0 ? ((x1 - x0) * (y1 - y0)) / 4 : 0;
}

/** Collapsed containers in frame, largest on screen first. */
export function blocksInFrame(scene: MapScene): { id: ElementId; a: number }[] {
    const out: { id: ElementId; a: number }[] = [];
    for (const [id, v] of scene.nodes) if (!v.ghost && !v.node._plate && v.node.children.length) {
        const a = screenArea(scene, id);
        if (a > 0) out.push({ id, a });
    }
    return out.sort((x, y) => y.a - x.a);
}

/**
 * Nodes under a screen point, nearest first, the dimmed ones (outside the focus) too: a name under the cursor first,
 * then what a ray through the point hits.
 */
export function nodesAt(scene: MapScene, x: number, y: number): ElementId[] {
    const out: ElementId[] = [];
    const lbl = scene.root.elementFromPoint(x, y)?.closest?.<HTMLElement>('[data-id]');
    if (lbl && scene.nodes.has(lbl.dataset.id!)) out.push(lbl.dataset.id!);
    aim(scene, x, y);
    for (const h of scene.raycaster.intersectObjects(bodies(scene), false)) {
        const id = h.object.userData.id;
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

/**
 * The block the cursor points at: under it, else the nearest one within `max` px of it. Closed containers only,
 * unless `leaves`; `accept(id)` narrows the choice (the nearest acceptable one wins, not the nearest of all).
 */
export function blockNear(scene: MapScene, x: number, y: number, { max = 140, ghosts = false, leaves = false, accept = null }: { max?: number; ghosts?: boolean; leaves?: boolean; accept?: ((id: ElementId) => boolean) | null } = {}): ElementId | null {
    const r = stageRect(scene);
    let best: { id: ElementId; dist: number } | null = null;
    for (const [id, v] of scene.nodes) {
        if ((v.ghost && !ghosts) || v.node._plate || (!leaves && !v.node.children.length)) continue;
        if (accept && !accept(id)) continue;
        const q = ndcRect(scene, v);
        if (q.behind) continue;
        const x0 = r.left + ((q.x0 + 1) / 2) * r.width, x1 = r.left + ((q.x1 + 1) / 2) * r.width;
        const y0 = r.top + ((1 - q.y1) / 2) * r.height, y1 = r.top + ((1 - q.y0) / 2) * r.height;
        const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
        const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
        const dist = Math.hypot(dx, dy);
        if (dist <= max && (!best || dist < best.dist)) best = { id, dist };
    }
    return best?.id ?? null;
}

/** Where a node's body is on screen (client px), or null when it is behind the camera. */
export function screenCenter(scene: MapScene, id: ElementId): ScreenPoint | null {
    const v = scene.nodes.get(id);
    if (!v) return null;
    const q = ndcRect(scene, v);
    if (q.behind) return null;
    const r = stageRect(scene);
    return { x: r.left + (((q.x0 + q.x1) / 2 + 1) / 2) * r.width, y: r.top + ((1 - (q.y0 + q.y1) / 2) / 2) * r.height };
}

/**
 * Zooming in toward nothing: the wheel's zoom goes toward block `id` instead of the cursor (null: the cursor
 * again). Lasts while the wheel moves; a flight or the wheel going out ends it.
 */
export function steerZoom(scene: MapScene, id: ElementId | null): void {
    const c = id ? screenCenter(scene, id) : null;
    scene.controls.steer = c;
    if (!c) return;
    scene.controls.zoomAt = c;
    // The wheel zooms by the distance to the orbit target, a point in front of the camera: with nothing at that
    // depth the steps shrink toward it and the camera stalls in empty space short of the block. The target moves
    // along the view axis to the block's depth (the view does not turn), so the zoom arrives at the block.
    TB.setFromObject(scene.nodes.get(id!)!.body, false).getCenter(TV); // c: the node is on the map
    const fwd = TV2.set(0, 0, -1).transformDirection(scene.camera.matrixWorld);
    const depth = TV.sub(scene.camera.position).dot(fwd);
    if (depth > 1) scene.controls.target.copy(scene.camera.position).addScaledVector(fwd, depth);
}

/**
 * The bottom of the map under the cursor: the zoom still queued is dropped and the wheel no longer zooms in, until
 * it zooms out, the pointer moves on (`at`: where it stands now) or the camera is taken another way. `false` lifts it.
 */
export function zoomFloor(scene: MapScene, at: ScreenPoint | null | false | undefined): void {
    const c = scene.controls;
    if (!at) return void (c.floor = null);
    c.zoomLeft = Math.min(0, c.zoomLeft);
    c.zoomMid = Math.min(0, c.zoomMid);
    c.floor = { x: at.x, y: at.y };
}

/** A ring on a label that fills up as the block nears the size where it opens. */
/**
 * The «go inside» progress on a block: the app sets a target (checked every ~100 ms while the wheel moves); the
 * frame loop eases the shown value toward it, so the ring fills smoothly and the block lights up with it.
 */
export function setPreview(scene: MapScene, id: ElementId | null, p?: number, mode = 'enter') {
    if (scene.preview?.done) return; // the ring is finishing an entry
    // nothing to open any more: the ring drains instead of vanishing
    if (!id) return scene.preview && ((scene.preview.target = 0), (scene.preview.fading = true), (scene.dirty = true));
    if (scene.preview && scene.preview.id !== id) endPreview(scene);
    const v = scene.nodes.get(id);
    if (!v) return;
    if (scene.preview) scene.preview.fading = false;
    if (!scene.preview) {
        scene.preview = { id, shown: 0, target: 0, base: v.emissive?.emissiveIntensity ?? 0 };
        v.label.element.classList.add('preview');
    }
    v.label.element.classList.toggle('switch', mode === 'switch'); // the focus moves here (it is open already)
    scene.preview.target = Math.max(0, Math.min(1, p!)); // given with an id
    scene.dirty = true;
}

/** The block opens: the ring runs to full, holds a moment and goes. */
export function completePreview(scene: MapScene, id: ElementId, mode = 'enter'): void {
    if (!scene.preview || scene.preview.id !== id) {
        endPreview(scene);
        setPreview(scene, id, 1, mode);
    }
    const pv = scene.preview;
    if (!pv) return;
    pv.target = 1;
    pv.fading = false;
    pv.done = performance.now() + 420;
    // the block becomes an open plate (a new visual): give the glow back now and leave the new one alone
    const v = scene.nodes.get(id);
    if (v?.emissive?.emissive) v.emissive.emissiveIntensity = pv.base;
}

export function endPreview(scene: MapScene): void {
    const pv = scene.preview;
    if (!pv) return;
    scene.preview = null;
    const v = scene.nodes.get(pv.id);
    if (!v) return;
    v.label.element.classList.remove('preview', 'switch');
    v.label.element.style.removeProperty('--p');
    v.label.element.style.removeProperty('--g');
    if (v.emissive?.emissive && !pv.done) v.emissive.emissiveIntensity = pv.base;
    scene.dirty = true;
}

export function stepPreview(scene: MapScene, now: number, dt: number) {
    const pv = scene.preview;
    if (!pv) return;
    if (pv.done && now > pv.done) return endPreview(scene);
    const v = scene.nodes.get(pv.id);
    if (!v) return (scene.preview = null);
    const next = pv.shown + (pv.target - pv.shown) * Math.min(1, dt * 12);
    const moving = Math.abs(next - pv.shown) > 0.0005;
    pv.shown = Math.abs(pv.target - next) < 0.002 ? pv.target : next;
    const el = v.label.element;
    el.style.setProperty('--p', `${(pv.shown * 100).toFixed(1)}%`);
    el.style.setProperty('--g', pv.shown.toFixed(3));
    // the block itself glows brighter as it gets closer to opening
    if (v.emissive?.emissive && !pv.done) v.emissive.emissiveIntensity = pv.base + 0.9 * pv.shown * pv.shown;
    if (moving) scene.dirty = true;
    if (pv.fading && pv.shown < 0.01) endPreview(scene);
}

/** How wide a node is on screen, in pixels, and the width of the map. */
export function screenWidth(scene: MapScene, id: ElementId): { px: number; W: number } {
    const v = scene.nodes.get(id);
    if (!v) return { px: 0, W: 1 };
    const W = scene.renderer.domElement.clientWidth;
    const q = ndcRect(scene, v);
    if (q.behind) return { px: W, W }; // a corner behind the camera: it fills the screen
    const min = Math.max(-1, q.x0), max = Math.min(1, q.x1);
    return { px: max > min ? ((max - min) * W) / 2 : 0, W };
}

/**
 * Raycast targets, kept between hovers and rebuilt only when the layout or the view changed (`hitCache = null`):
 * `all` — shown relations and blocks that are not ghosts, `nodes` — those blocks, `bodies` — every block.
 */
export function hitLists(scene: MapScene): NonNullable<MapScene['hitCache']> {
    if (scene.hitCache) return scene.hitCache;
    const nodes: THREE.Object3D[] = [], allBodies: THREE.Object3D[] = [], all: THREE.Object3D[] = [];
    for (const v of scene.nodes.values()) {
        allBodies.push(v.body);
        if (!v.ghost) nodes.push(v.body);
    }
    for (const v of scene.edges.values()) if (!v.hidden) all.push(v.hit);
    for (const b of nodes) all.push(b);
    return (scene.hitCache = { all, nodes, bodies: allBodies });
}

export function bodies(scene: MapScene): THREE.Object3D[] {
    return hitLists(scene).bodies;
}

/** The map's box on the page: kept until the map is resized or the page scrolls (a narrow screen scrolls). */
export function stageRect(scene: MapScene): DOMRect {
    return (scene.rect ??= scene.renderer.domElement.getBoundingClientRect());
}

/** Points the raycaster through a client point. */
export function aim(scene: MapScene, x: number, y: number): void {
    const r = stageRect(scene);
    scene.pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    scene.raycaster.setFromCamera(scene.pointer, scene.camera);
}

/** The point is within the middle half (each way) of the block's box on screen — a line may cross a block's edge, not its heart. */
function atCentre(scene: MapScene, id: ElementId, x: number, y: number): boolean {
    const v = scene.nodes.get(id);
    if (!v) return false;
    const q = ndcRect(scene, v);
    if (q.behind) return false;
    const r = stageRect(scene);
    const px = ((x - r.left) / r.width) * 2 - 1, py = -(((y - r.top) / r.height) * 2 - 1);
    const cx = (q.x0 + q.x1) / 2, cy = (q.y0 + q.y1) / 2;
    return Math.abs(px - cx) <= (q.x1 - q.x0) / 4 && Math.abs(py - cy) <= (q.y1 - q.y0) / 4;
}

/** The block (not a plate) whose middle half holds the point, nearest to the camera, or null. */
function blockAtCentre(scene: MapScene, x: number, y: number): Hit | null {
    aim(scene, x, y);
    const block = scene.raycaster.intersectObjects(hitLists(scene).nodes, false).find((h) => h.object.userData.type === 'node' && !scene.nodes.get(h.object.userData.id)?.node._plate);
    return block && atCentre(scene, block.object.userData.id, x, y) ? (block.object.userData as Hit) : null;
}

/** Where a block's body is on screen (client px): left, top, right, bottom; null when a corner is behind the camera. */
export function screenRect(scene: MapScene, id: ElementId): { x0: number; y0: number; x1: number; y1: number } | null {
    const v = scene.nodes.get(id);
    if (!v) return null;
    const q = ndcRect(scene, v);
    if (q.behind) return null;
    const r = stageRect(scene);
    return { x0: r.left + ((q.x0 + 1) / 2) * r.width, x1: r.left + ((q.x1 + 1) / 2) * r.width, y0: r.top + ((1 - q.y1) / 2) * r.height, y1: r.top + ((1 - q.y0) / 2) * r.height };
}

/** Where a block's name is on screen (client px), or null when it is not shown. */
export function labelRect(scene: MapScene, id: ElementId): Box | null {
    const v = scene.nodes.get(id);
    if (!v?.label.visible) return null;
    const r = v.label.element.getBoundingClientRect();
    return r.width ? { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } : null;
}

/** Screen boxes (client px) of the names shown now, but those of `skip` (a hover card would rather not cover one). */
export function nameBoxes(scene: MapScene, skip: Set<ElementId>): Box[] {
    const out: Box[] = [];
    for (const id of scene.nodes.keys()) {
        const b = skip.has(id) ? null : labelRect(scene, id);
        if (b) out.push(b);
    }
    return out;
}

/** The blocks drawn now — not plates, not ghosts, not `skip` — that are on the map, with their screen boxes (client px). */
export function blocksOnMap(scene: MapScene, skip: Set<ElementId> = new Set()): (Box & { id: ElementId })[] {
    const r = stageRect(scene), out: (Box & { id: ElementId })[] = [];
    for (const [id, v] of scene.nodes) {
        if (skip.has(id) || v.ghost || v.node._plate || !v.obj.visible) continue;
        const b = screenRect(scene, id);
        if (b && b.x1 > r.left && b.y1 > r.top && b.x0 < r.right && b.y0 < r.bottom) out.push({ id, ...b });
    }
    return out;
}

/** Screen boxes (client px) of the blocks on the map but `skip` (the hover card's placement). */
export const blockBoxes = (scene: MapScene, skip: Set<ElementId>): Box[] => blocksOnMap(scene, skip).map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));

export function pick(scene: MapScene, e: PickEvent, nodesOnly = false): Hit | null {
    const lbl = (e.target as Element).closest?.<HTMLElement>(nodesOnly ? '[data-id]' : '[data-env],[data-edge],[data-id]');
    // a chip on a line is no better than the line: at a block's centre the block wins (a chip clear of the heart still counts)
    if (lbl && (lbl.dataset.env || lbl.dataset.edge)) {
        const c = blockAtCentre(scene, e.clientX, e.clientY);
        if (c) return c;
    }
    // a block's name is that block's — except over another block's middle, which belongs to that block (a name in a
    // dense grid that had to stand over a neighbour does not take the neighbour's pointer)
    if (lbl?.dataset.id) {
        const c = blockAtCentre(scene, e.clientX, e.clientY);
        if (c && c.id !== lbl.dataset.id) return c;
    }
    if (lbl?.dataset.env) return { type: 'envelope', id: lbl.dataset.env, edge: lbl.dataset.of };
    if (lbl) return lbl.dataset.edge ? { type: 'edge', id: lbl.dataset.edge } : { type: 'node', id: lbl.dataset.id! };
    aim(scene, e.clientX, e.clientY);
    const lists = hitLists(scene);
    const hits = scene.raycaster.intersectObjects(nodesOnly ? lists.nodes : lists.all, false);
    // an edge beats the plate under it; a block beats the plate it stands on
    // ... except at a block's centre: relations end and pass there, and a block must be pickable where it is pointed at
    const block = hits.find((h) => h.object.userData.type === 'node' && !scene.nodes.get(h.object.userData.id)?.node._plate);
    const best = (block && atCentre(scene, block.object.userData.id, e.clientX, e.clientY) ? block : null) ?? hits.find((h) => h.object.userData.type === 'edge') ?? block ?? hits[0];
    return best ? (best.object.userData as Hit) : null; // nodes, relations and layer fields carry { type, id }
}
