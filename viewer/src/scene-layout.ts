// A change of layout: the tween of every block, the fades of what leaves or comes in, the views of nodes and layer fields.
import * as THREE from 'three';
import { buildVisual, disposeVisual } from './shapes.ts';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { sceneColors } from './theme.ts';
import { ease, smooth, MOVE_MS, ENTER_MS, EDGE_OUT_MS, OPACITY_RATE, esc } from './scene-util.ts';
import type { MapScene } from './scene.ts';
import type { Anim, Fade, FadeMat, Drawable, Label, NodeView, PlateView, Tween } from './scene-types.ts';
import type { Model, PlacedNode, RoutedEdge, ViewNode } from '../../types/viewer.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { Plate } from './layout.ts';

const V0 = new THREE.Vector3();

/** Size of a mesh's geometry, local units. */
function dimsOf(mesh: THREE.Mesh): THREE.Vector3 {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox!.getSize(new THREE.Vector3()).max(new THREE.Vector3(1e-3, 1e-3, 1e-3));
}

/** Every material under an object with the opacity it has now (for a fade). */
function materialsOf(obj: THREE.Object3D): FadeMat[] {
    const out: FadeMat[] = [];
    obj.traverse((x) => {
        const o = x as Drawable;
        if (o.material) out.push({ m: o.material, from: o.material.opacity });
    });
    for (const x of out) x.m.transparent = true;
    return out;
}

function disposeObj(obj: THREE.Object3D): void {
    obj.traverse((x) => {
        const o = x as Drawable;
        o.geometry?.dispose();
        o.material?.dispose();
    });
}

function subtitle(n: ViewNode): string {
    // a client-layer system names what it is made of; the counts are one level down
    if (n.type === 'system') return n.children.length > 2 ? `${n.children.length} apps` : n.children.map((c) => c.title).join(' · ');
    if (n.type === 'actor') return '';
    if (n._rail) return n.technology ?? '';
    if (n.endpoints?.length) return `${n.endpoints.length} endpoints`;
    if (n.type === 'table') return `${n.columns?.length ?? 0} columns`;
    if (n.children.length) return `${n.leafCount} inside`;
    return n.type === 'external-system' ? n.technology ?? '' : ''; // the file path is in the panel; on the map it is noise
}

// ---------- layout ----------
export function setLayout(scene: MapScene, { placed, plates }: { placed: PlacedNode[]; plates: Plate[] }, folded: RoutedEdge[], model: Model): void {
    scene.hitCache = null;
    const prev = new Map([...scene.nodes].map(([id, v]) => [id, v.obj.position.clone()]));
    shiftToWorldOffset(scene, placed, plates, prev);
    const first = !prev.size;
    if (!first && !scene.anim && sameLayout(scene, placed, plates, prev)) {
        // nothing moves (a scenario step, a filter that keeps the blocks): no motion, the relations are rebuilt in
        // place and only the new ones fade in — lines must not blink on every step of a scenario
        for (const n of placed) updateNode(scene, scene.nodes.get(n.id)!, n); // sameLayout: every one is on the map
        scene.anchor = null;
        scene.buildEdges(folded, model);
        return;
    }
    finishMotion(scene); // a change cut short: what was leaving or fading goes now
    const leaving = retireNodes(scene, placed, first);
    if (first) scene.clearEdges();
    else fadeOutEdges(scene);
    scene.clearPulses();
    replacePlates(scene, plates, first);
    const { tweens, byId } = nodeTweens(scene, placed, prev, first);
    growNewParts(model, tweens, byId, prev);
    tweens.push(...leavingTweens(model, leaving, byId));
    // keep a block where it was on screen (auto focus): move the camera with it
    const entering = !!scene.anchor;
    const camDelta = anchorShift(scene, byId);
    scene.anim = { t0: performance.now(), dur: first || !scene.motion ? 0 : entering ? ENTER_MS : MOVE_MS, tweens, camDelta, kPrev: 0, done: () => (scene.buildEdges(folded, model), first && scene.fitAll(true)) };
    if (!first) stepAnim(scene, scene.anim.t0); // the first frame already shows the start: nothing new at full size
    scene.dirty = true;
}

/** The new layout is moved by the world offset (the block that was opened or left stays where it was); the layer fields too. */
function shiftToWorldOffset(scene: MapScene, placed: PlacedNode[], plates: Plate[], prev: Map<ElementId, THREE.Vector3>): void {
    // The block the wheel opens (or leaves) stays where it is: the world moves around it, not the block. The shift
    // is kept, so later layouts (filters, scenario steps) don't jump back to the origin.
    scene.worldOffset ??= new THREE.Vector3();
    const centerOf = (n: PlacedNode) => new THREE.Vector3(n._pos.x + n._size.w / 2, n._pos.y + n._size.h / 2, n._pos.z + n._size.d / 2);
    const anchored = scene.anchor && placed.find((n) => n.id === scene.anchor);
    if (anchored && prev.has(anchored.id)) scene.worldOffset.copy(prev.get(anchored.id)!).sub(centerOf(anchored));
    const o = scene.worldOffset;
    for (const n of placed) n._pos = { x: n._pos.x + o.x, y: n._pos.y + o.y, z: n._pos.z + o.z };
    for (const p of plates) {
        p.ox = o.x;
        p.y += o.y;
        p.oz = o.z;
    }
}

/** What is not in the new layout: dropped at once on the first layout, else taken off the map and returned (it shrinks back into the block that stays, then goes). */
function retireNodes(scene: MapScene, placed: PlacedNode[], first: boolean): NodeView[] {
    const keep = new Set(placed.map((n) => n.id));
    const leaving: NodeView[] = [];
    for (const [id, v] of scene.nodes) {
        if (keep.has(id)) continue;
        if (first) dropNode(scene, id, v);
        else {
            // shrinks back into the block that stays, then goes
            leaving.push(v);
            scene.nodes.delete(id);
        }
    }
    return leaving;
}

/** The old layer fields go (at once, or fading out) and the new ones come (fading in unless it is the first layout). */
function replacePlates(scene: MapScene, plates: Plate[], first: boolean): void {
    for (const p of scene.plates) {
        if (first) {
            scene.group.remove(p.mesh);
            disposeObj(p.mesh);
            p.label.element.remove();
            scene.group.remove(p.label);
        } else fadeOut(scene, [p.mesh], [p.label], EDGE_OUT_MS);
    }
    scene.plates = plates.map((p) => makeLayerPlate(scene, p));
    if (!first) for (const p of scene.plates) fadeIn(scene, p.mesh, p.label, ENTER_MS * 0.6);
}

/** The nearest block, up the tree, that is on the map both before and after: what a new part grows out of and what a leaving part goes back into. */
function nearestKept(model: Model, id: ElementId, has: (id: ElementId) => boolean): ElementId | null {
    for (let a = model.nodes.get(id)?.parent; a; a = model.nodes.get(a)?.parent) if (has(a)) return a;
    return null;
}

/** One tween per block of the new layout (made or updated here): from where it is (or nowhere yet) to its place. */
function nodeTweens(scene: MapScene, placed: PlacedNode[], prev: Map<ElementId, THREE.Vector3>, first: boolean): { tweens: Tween[]; byId: Map<ElementId | null, Tween> } {
    const tweens: Tween[] = [];
    const byId = new Map<ElementId | null, Tween>();
    for (const n of placed) {
        let v = scene.nodes.get(n.id);
        const old = !!v;
        if (!v) v = makeNode(scene, n);
        else updateNode(scene, v, n, !first);
        const to = new THREE.Vector3(n._pos.x + n._size.w / 2, n._pos.y + n._size.h / 2, n._pos.z + n._size.d / 2);
        const tw: Tween = { v, from: old ? prev.get(n.id) : null, to, fade0: old ? v.fade ?? 1 : 0 };
        if (v.morph) {
            // the block opens (or closes) in place: the new board starts at the old tile's size and the tile grows
            // into the board while it fades; the scale goes from s0 to 1 (s0 = old size / new size, per axis)
            tw.morph = v.morph;
            tw.s0 = v.morph.s0;
            tw.fade0 = 0; // the board comes in as the tile goes
            v.morph = null;
        } else if (old && Math.abs(v.obj.scale.x - 1) + Math.abs(v.obj.scale.y - 1) + Math.abs(v.obj.scale.z - 1) > 1e-3) tw.s0 = v.obj.scale.clone(); // a change cut short: grow on from where it is
        tweens.push(tw);
        byId.set(n.id, tw);
    }
    return { tweens, byId };
}

/** The scale a part starts at inside the block that grows (or the one it goes back into). */
const g0Of = (tw: Tween | undefined) => (tw?.morph ? (tw.morph.s0.x + tw.morph.s0.z) / 2 : 0.2);

/** A new part grows out of the block it is in: placed inside the growing board, at its scale. */
function growNewParts(model: Model, tweens: Tween[], byId: Map<ElementId | null, Tween>, prev: Map<ElementId, THREE.Vector3>): void {
    for (const tw of tweens) {
        if (tw.from) continue;
        const src = byId.get(nearestKept(model, tw.v.node.id, (a) => prev.has(a) && byId.has(a)));
        tw.from = tw.to.clone();
        if (src) tw.src = { tw: src, rel: tw.to.clone().sub(src.to), g0: g0Of(src), g1: 1 };
    }
}

/** A tween for each part that leaves: back into the block that stays, to its new place, at the scale it shrinks to. */
function leavingTweens(model: Model, leaving: NodeView[], byId: Map<ElementId | null, Tween>): Tween[] {
    const out: Tween[] = [];
    for (const v of leaving) {
        const src = byId.get(nearestKept(model, v.node.id, (a) => byId.has(a)));
        const from = v.obj.position.clone();
        const tw: Tween = { v, from, to: from, leave: true, fade0: v.fade ?? 1 };
        // back into the block: to its new place, at the scale it shrinks to
        if (src) tw.src = { tw: src, rel: from.clone().sub(src.from!), g0: 1, g1: src.morph ? 1 / g0Of(src) : 0.2 };
        out.push(tw);
    }
    return out;
}

/** How far the block the wheel opened (or left) moved, for the camera to move with it; the anchor is used up. */
function anchorShift(scene: MapScene, byId: Map<ElementId | null, Tween>): THREE.Vector3 | null {
    let camDelta: THREE.Vector3 | null = null;
    if (scene.anchor) {
        const tw = byId.get(scene.anchor);
        if (tw) camDelta = tw.to.clone().sub(tw.from!);
        scene.anchor = null;
    }
    return camDelta;
}

/** The new layout puts every block where it is now, at the same size, with the same layer fields. */
export function sameLayout(scene: MapScene, placed: PlacedNode[], plates: Plate[], prev: Map<ElementId, THREE.Vector3>): boolean {
    if (placed.length !== scene.nodes.size || plates.length !== scene.plates.length) return false;
    for (const n of placed) {
        const v = scene.nodes.get(n.id), at = prev.get(n.id);
        if (!v || !at || v.sz !== `${n._plate}|${n._size.w.toFixed(2)}|${n._size.h.toFixed(2)}|${n._size.d.toFixed(2)}`) return false;
        if (Math.abs(at.x - (n._pos.x + n._size.w / 2)) + Math.abs(at.y - (n._pos.y + n._size.h / 2)) + Math.abs(at.z - (n._pos.z + n._size.d / 2)) > 1e-3) return false;
    }
    return plates.every((p, i) => {
        const q = scene.plates[i].p;
        return q.w === p.w && q.d === p.d && q.y === p.y && q.ox === p.ox && q.oz === p.oz;
    });
}

/** One frame of a layout change at time `now`. */
export function stepAnim(scene: MapScene, now: number): void {
    const a = scene.anim!;
    const t = a.dur ? Math.max(0, Math.min(1, (now - a.t0) / a.dur)) : 1;
    const k = ease(t);
    // a camera flight started with the relayout already aims at the new place: don't also drag the camera
    if (a.camDelta && !scene.cam) {
        const step = a.camDelta.clone().multiplyScalar(k - a.kPrev);
        scene.camera.position.add(step);
        scene.controls.target.add(step);
    }
    a.kPrev = k;
    const sp = new THREE.Vector3();
    for (const tw of a.tweens) {
        const v = tw.v;
        if (tw.src) {
            const s = tw.src;
            sp.lerpVectors(s.tw.from!, s.tw.to, k);
            const g = s.g0 + (s.g1 - s.g0) * k;
            v.obj.position.copy(s.rel).multiplyScalar(g).add(sp);
            v.obj.scale.setScalar(g);
        } else {
            v.obj.position.lerpVectors(tw.from!, tw.to, k);
            if (tw.morph) v.obj.position.addScaledVector(tw.morph.d0, 1 - k);
            if (tw.s0) v.obj.scale.lerpVectors(tw.s0, V0.set(1, 1, 1), k);
            else v.obj.scale.setScalar(1);
        }
        // fades follow time, not the eased motion: a part comes in at an even pace, never in one frame
        if (tw.leave) v.fade = tw.fade0 * (1 - smooth(t, 0, 0.55));
        else if (tw.morph) v.fade = tw.fade0 + (1 - tw.fade0) * smooth(t, 0, 0.45);
        else if (tw.fade0 < 1) v.fade = tw.fade0 + (1 - tw.fade0) * smooth(t, 0.1, 0.75);
        v.fading = t < 1 && (tw.leave || tw.morph || tw.fade0 < 1);
        if (tw.morph) {
            // the old tile: grows (or shrinks) to the new size with the new board, and fades
            const m = tw.morph;
            m.obj.scale.lerpVectors(m.sc0, m.s1, k);
            m.obj.position.copy(v.obj.position).add(sp.copy(v.body.position).multiply(v.obj.scale)).sub(V0.copy(m.ob).multiply(m.obj.scale));
            const f = 1 - smooth(t, 0.1, 0.6);
            for (const x of m.mats) x.m.opacity = x.from * f;
        }
        if (tw.leave) for (const e of v.mats) e.m.opacity = (e.cur ?? e.base) * v.fade!;
        placeLabel(scene, v);
        const lf = v.fading ? (tw.morph ? smooth(t, 0.45, 0.85) : v.fade!) : 1; // a morphing block's name waits for the board
        v.label.element.style.filter = lf < 1 ? `opacity(${lf.toFixed(3)})` : '';
    }
    scene.opacityMoving = true;
    scene.dirty = true;
    if (t >= 1) {
        scene.anim = null;
        endTweens(scene, a);
        a.done();
    }
}

/** Drops what a change left behind: old tiles, leaving parts. */
export function endTweens(scene: MapScene, a: Anim): void {
    for (const tw of a.tweens) {
        tw.v.fading = false;
        if (tw.morph) {
            scene.group.remove(tw.morph.obj);
            disposeVisual(tw.morph);
            tw.morph = null;
        }
        if (tw.leave) {
            scene.group.remove(tw.v.obj);
            disposeVisual(tw.v);
            tw.v.label.element.remove();
            scene.group.remove(tw.v.label);
        } else tw.v.label.element.style.filter = '';
    }
}

/** A change cut short by another: what it left behind goes now, the fades end. */
export function finishMotion(scene: MapScene): void {
    if (scene.anim) {
        const a = scene.anim;
        scene.anim = null;
        endTweens(scene, a);
    }
    for (const f of scene.fades) endFade(scene, f);
    scene.fades = [];
}

/** Name of a node at the place and the scale its body has now. */
export function placeLabel(scene: MapScene, v: NodeView): void {
    const n = v.node, p = v.obj.position, s = v.obj.scale, sz = n._size;
    const w = sz.w * s.x, h = sz.h * s.y, d = sz.d * s.z;
    if (n._plate) v.label.position.set(p.x - w / 2 + 1.3, p.y + h / 2 + 0.2, p.z - d / 2 + 0.8);
    else if (n._rail) v.label.position.set(p.x + (n._railIndex! % 2 ? 1 : -1) * (w / 2 - Math.min(10, w * 0.12)), p.y + h / 2 + 0.3, p.z); // its name at one end
    else v.label.position.set(p.x, p.y + (-sz.h / 2 + Math.max(0.35, sz.h * 0.45)) * s.y + 0.5, n.parent ? p.z : p.z - d * 0.38); // just above the thin tile; a client-layer name stands behind its larger tile
}

// ---------- fades of things that are not nodes: old relations, layer fields ----------
export function fadeOut(scene: MapScene, objs: THREE.Object3D[], labels: Label[], dur: number): void {
    const mats = objs.flatMap((o) => materialsOf(o));
    scene.fades.push({ out: true, objs, labels, mats, t0: performance.now(), dur });
}

export function fadeIn(scene: MapScene, obj: THREE.Object3D, label: Label, dur: number): void {
    const mats = materialsOf(obj).map((x) => ((x.m.opacity = 0), x));
    label.element.style.filter = 'opacity(0)';
    scene.fades.push({ out: false, objs: [obj], labels: [label], mats, t0: performance.now(), dur });
}

export function endFade(scene: MapScene, f: Fade): void {
    if (f.out) {
        for (const o of f.objs) {
            scene.group.remove(o);
            disposeObj(o);
        }
        for (const l of f.labels) {
            l.element.remove();
            scene.group.remove(l);
        }
    } else {
        for (const x of f.mats) x.m.opacity = x.from;
        for (const l of f.labels) l.element.style.filter = '';
    }
}

export function stepFades(scene: MapScene, now: number): void {
    if (!scene.fades.length) return;
    scene.fades = scene.fades.filter((f) => {
        const k = ease(Math.min(1, (now - f.t0) / f.dur));
        const o = f.out ? 1 - k : k;
        for (const x of f.mats) x.m.opacity = x.from * o;
        for (const l of f.labels) l.element.style.filter = `opacity(${o.toFixed(3)})`;
        if (k < 1) return true;
        endFade(scene, f);
        return false;
    });
    scene.dirty = true;
}

/** Relations of the old layout fade out where they are; the new ones are built when the layout lands. */
export function fadeOutEdges(scene: MapScene): void {
    const objs: THREE.Object3D[] = [], labels: Label[] = [];
    for (const v of scene.edges.values()) {
        scene.group.remove(v.hit);
        v.hit.geometry.dispose();
        v.hit.material.dispose();
        objs.push(v.tube);
        labels.push(v.label);
    }
    scene.edges.clear();
    scene.hitCache = null;
    scene.syncChips(null);
    scene.edgeFade = null;
    if (objs.length) fadeOut(scene, objs, labels, EDGE_OUT_MS);
}

/**
 * Opacity of every node eases to what the view asks (dimming, ghosting, lighting), times its own fade while it
 * grows in or leaves. A node fading by a running change follows it exactly.
 */
export function stepOpacity(scene: MapScene, dt: number): void {
    if (!scene.opacityMoving) return;
    const a = Math.min(1, (dt / 1000) * OPACITY_RATE);
    let moving = !!scene.anim;
    for (const v of scene.nodes.values()) {
        const f = v.fade ?? 1;
        for (const e of v.mats) {
            const want = (e.view ?? e.base) * f;
            if (e.cur === undefined || v.fading || Math.abs(want - e.cur) < 0.002) e.cur = want;
            else {
                e.cur += (want - e.cur) * a;
                moving = true;
            }
            e.m.opacity = e.cur;
        }
    }
    scene.opacityMoving = moving;
    if (moving) scene.dirty = true;
}

export function makeNode(scene: MapScene, n: PlacedNode): NodeView {
    const el = document.createElement('div');
    el.className = 'nlabel';
    el.dataset.id = n.id;
    const label = new CSS2DObject(el) as Label;
    scene.group.add(label);
    const v = { node: n, label } as NodeView; // updateNode gives it its visual
    scene.nodes.set(n.id, v);
    updateNode(scene, v, n);
    return v;
}

/**
 * (Re)builds the visual when the node changed between block and plate or got another size. With `morph`, the old
 * visual stays for the change to turn into the new one (`v.morph`: the old visual, its materials, the scales).
 */
export function updateNode(scene: MapScene, v: NodeView, n: PlacedNode, morph = false): void {
    const sz = `${n._plate}|${n._size.w.toFixed(2)}|${n._size.h.toFixed(2)}|${n._size.d.toFixed(2)}`;
    if (v.sz !== sz) {
        const pos = v.obj?.position.clone();
        const prev = v.obj && { obj: v.obj, body: v.body, mats: materialsOf(v.obj), scale: v.obj.scale.clone() };
        if (v.obj && !morph) {
            scene.group.remove(v.obj);
            disposeVisual(v);
        }
        Object.assign(v, buildVisual(n, scene.kit));
        scene.hitCache = null;
        if (prev && morph) {
            // on screen the old tile is its body's size: the new board starts there, the tile ends at the board's
            const a = dimsOf(prev.body).multiply(prev.scale), b = dimsOf(v.body);
            const s0 = a.clone().divide(b);
            // a tile's body sits low in its node, a board's in the middle: the two bodies are kept concentric, the
            // new one drifting to its own place as it grows (d0: where the old body's center is, from the new one's)
            const d0 = prev.body.position.clone().multiply(prev.scale).sub(v.body.position.clone().multiply(s0));
            v.morph = { obj: prev.obj, mats: prev.mats, s0, sc0: prev.scale, s1: b.clone().divide(a).multiply(prev.scale), d0, ob: prev.body.position.clone() };
            v.obj.scale.copy(v.morph.s0);
        }
        v.baseColor = v.emissive.color.clone();
        v.baseEmissive = null;
        if (pos) v.obj.position.copy(pos);
        scene.group.add(v.obj);
        v.sz = sz;
        v.plate = n._plate;
        v.label.center.set(n._plate ? 0 : 0.5, n._plate ? 0 : 1);
    }
    v.node = n;
    const sub = subtitle(n);
    const root = !n.parent && n.type !== 'app' && n.type !== 'datastore'; // the client layer: larger names
    v.label.element.className = `nlabel ${n._plate ? 'plate' : 'block'} t-${n.type} s-${n.shape}${n.context ? ' ctx' : ''}${root ? ' root' : ''}`;
    v.label.element._m = null;
    v.label.element.innerHTML = `<b>${esc(n.title)}</b>${n.children.length && !root ? `<i>${n._plate ? '−' : '+' + n.leafCount}</i>` : ''}${sub && !n._plate ? `<span>${esc(sub)}</span>` : ''}`;
}

export function dropNode(scene: MapScene, id: ElementId, v: NodeView): void {
    scene.hitCache = null;
    scene.group.remove(v.obj);
    disposeVisual(v);
    v.label.element.remove();
    scene.group.remove(v.label);
    scene.nodes.delete(id);
}

export function makeLayerPlate(scene: MapScene, p: Plate): PlateView {
    // a layer is a field of faint points with a thin border, not a slab
    const mesh = new THREE.Group();
    const dots: THREE.Vector3[] = [];
    for (let x = -p.w / 2; x <= p.w / 2; x += 4) for (let z = -p.d / 2; z <= p.d / 2; z += 4) dots.push(new THREE.Vector3(x, p.y - 0.4, z));
    const tint = sceneColors(scene.theme).layerDots;
    mesh.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(dots), new THREE.PointsMaterial({ color: tint, size: 0.18, transparent: true, opacity: 0.35, depthWrite: false })));
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(p.w, p.d)), new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: 0.25 }));
    border.rotation.x = -Math.PI / 2;
    border.position.y = p.y - 0.4;
    mesh.add(border);
    mesh.userData = { type: 'layer' };
    mesh.position.set(p.ox ?? 0, 0, p.oz ?? 0);
    scene.group.add(mesh);
    const el = document.createElement('div');
    el.className = 'layerlabel';
    el.textContent = p.layer.title;
    const label = new CSS2DObject(el) as Label;
    label.position.set((p.ox ?? 0) - p.w / 2 + Math.min(34, p.w * 0.2), p.y, (p.oz ?? 0) + p.d / 2); // on the front edge, clear of the corner the legend covers; the back edge sits behind the blocks' names
    label.center.set(0, 0);
    scene.group.add(label);
    return { mesh, label, p };
}
