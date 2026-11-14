// The camera: fitting the map, flights between places, the cinema's rides along a relation and drifts. Each function takes the
// MapScene it works on as its first argument; MapScene keeps one-line methods that call them.
import * as THREE from 'three';
import { ease } from './scene-util.ts';
import type { MapScene } from './scene.ts';
import type { EdgeView } from './scene-types.ts';
import type { Shot, ShotOptions } from '../../types/scene.ts';
import type { ElementId } from '../../types/spec.d.ts';

/**
 * Where `fitAll` puts the camera: the centre of the box and the distance from it, looking from the current side. The whole
 * map is framed by what it looks like on screen; a set of ids by its bounding sphere. Null when nothing is placed.
 */
export function fitDistance(scene: MapScene, ids?: Set<ElementId> | null): { c: THREE.Vector3; dir: THREE.Vector3; dist: number } | null {
    const box = new THREE.Box3();
    for (const v of scene.nodes.values()) {
        if (ids && !ids.has(v.node.id)) continue;
        const n = v.node;
        box.expandByPoint(new THREE.Vector3(n._pos.x, n._pos.y, n._pos.z));
        box.expandByPoint(new THREE.Vector3(n._pos.x + n._size.w, n._pos.y + n._size.h, n._pos.z + n._size.d));
    }
    if (box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    let dist = r / Math.sin(((scene.camera.fov / 2) * Math.PI) / 180) * 0.98;
    const dir = scene.camera.position.clone().sub(scene.controls.target).normalize();
    // the whole map is framed by what it looks like on screen, not by its bounding sphere (that leaves a third of
    // the frame empty and makes the first level far away); a focus keeps the sphere fit the zoom was tuned with
    if (!ids) dist = tightDistance(scene, box, c, dir, dist);
    return { c, dir, dist };
}

/** Camera so that every block fits the frame, looking from the current side. */
export function fitAll(scene: MapScene, instant?: boolean, ids?: Set<ElementId> | null): void {
    const f = fitDistance(scene, ids);
    if (!f) return;
    const { c, dir, dist } = f;
    const toC = c.clone().add(dir.clone().multiplyScalar(dist));
    if (instant) {
        scene.controls.target.copy(c);
        scene.camera.position.copy(toC);
        scene.dirty = true;
        return;
    }
    fly(scene, c, toC);
}

/**
 * Camera flight to target `toT`, camera at `toC`, as long as the layout change that runs with it. It leaves with the
 * velocity the camera has (the wheel zoom into a block carries on into the flight instead of stopping and starting
 * again: cubic Hermite, start tangent = that velocity, end tangent 0) and lands softly.
 */
export function fly(scene: MapScene, toT: THREE.Vector3, toC: THREE.Vector3, dur = scene.moveMs, { arc = false }: { arc?: boolean } = {}): void {
    if (scene.track) dropComet(scene); // a ride cut short: its comet goes with it
    scene.track = scene.drift = null;
    if (!scene.motion) {
        // reduced motion: a cut, not a flight
        scene.cam = null;
        scene.controls.enableZoom = true;
        scene.controls.hold();
        scene.controls.target.copy(toT);
        scene.camera.position.copy(toC);
        scene.dirty = true;
        return;
    }
    const span = scene.camera.position.distanceTo(toC) + scene.controls.target.distanceTo(toT);
    const tangent = (v: THREE.Vector3) => {
        const t = v.clone().multiplyScalar(dur);
        const max = span * 1.2 + 1; // a fast wheel never throws the flight far past its goal
        return t.length() > max ? t.setLength(max) : t;
    };
    scene.cam = { t0: performance.now(), dur, fromT: scene.controls.target.clone(), toT, fromC: scene.camera.position.clone(), toC, vT: tangent(scene.camVel.t), vC: tangent(scene.camVel.c) };
    if (arc) {
        // around the subject, not through it: the view direction turns on a sphere (radius in log, angles eased)
        const a = new THREE.Spherical().setFromVector3(scene.camera.position.clone().sub(scene.controls.target));
        const b = new THREE.Spherical().setFromVector3(toC.clone().sub(toT));
        let dth = b.theta - a.theta;
        dth -= Math.round(dth / (2 * Math.PI)) * 2 * Math.PI;
        scene.cam.arc = { a, dth, dphi: b.phi - a.phi, lr: Math.log(b.radius / a.radius) };
    }
    // the wheel would dolly against the flight every frame (the jitter on entering a level): hold it until it lands
    scene.controls.enableZoom = false;
    scene.controls.hold();
    scene.dirty = true;
}

export function stepCam(scene: MapScene, now: number): void {
    const c = scene.cam!;
    const t = Math.max(0, Math.min(1, (now - c.t0) / c.dur));
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = 3 * t2 - 2 * t3;
    const at = (out: THREE.Vector3, a: THREE.Vector3, va: THREE.Vector3, b: THREE.Vector3) => out.copy(a).multiplyScalar(h00).addScaledVector(va, h10).addScaledVector(b, h01);
    at(scene.controls.target, c.fromT, c.vT, c.toT);
    if (c.arc) {
        const k = ease(t), A = c.arc;
        const sph = new THREE.Spherical(A.a.radius * Math.exp(A.lr * k), A.a.phi + A.dphi * k, A.a.theta + A.dth * k);
        scene.camera.position.setFromSpherical(sph).add(scene.controls.target);
    } else at(scene.camera.position, c.fromC, c.vC, c.toC);
    scene.dirty = true;
    if (t >= 1) {
        scene.cam = null;
        scene.controls.enableZoom = true;
    }
}

/** World box of these nodes as laid out (their final places, not where a running change has them now). */
export function boxOf(scene: MapScene, ids: Iterable<ElementId>): THREE.Box3 {
    const box = new THREE.Box3();
    for (const id of ids) {
        const n = scene.nodes.get(id)?.node;
        if (!n) continue;
        box.expandByPoint(new THREE.Vector3(n._pos.x, n._pos.y, n._pos.z));
        box.expandByPoint(new THREE.Vector3(n._pos.x + n._size.w, n._pos.y + n._size.h, n._pos.z + n._size.d));
    }
    return box;
}

/**
 * Where the camera goes to show these nodes: `pad` × the distance that fits them, the view turned by `turn` rad
 * around the vertical, the subject `lift` of the half-height above the middle (a caption bar lies below) and
 * `shiftX` of the half-width left of it (a card on the right). `off`: where the target is from the subject.
 */
export function shotOf(scene: MapScene, ids: Iterable<ElementId>, { pad = 1.6, turn = 0, lift = 0.12, shiftX = 0, minR = 7 }: ShotOptions = {}): Shot | null {
    const box = boxOf(scene, ids);
    if (box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(minR, box.getSize(new THREE.Vector3()).length() / 2);
    const half = ((scene.camera.fov / 2) * Math.PI) / 180;
    const fit = r / Math.sin(Math.min(half, Math.atan(Math.tan(half) * scene.camera.aspect)));
    const dist = Math.min(scene.controls.maxDistance, fit * pad);
    const dir = scene.camera.position.clone().sub(scene.controls.target).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), turn);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(scene.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(scene.camera.quaternion);
    const toT = c.clone().addScaledVector(up, -dist * Math.tan(half) * lift).addScaledVector(right, dist * Math.tan(half) * scene.camera.aspect * shiftX);
    return { toT, toC: toT.clone().addScaledVector(dir, dist), dist, off: toT.clone().sub(c) };
}

/** Camera flight that frames these nodes (a scenario step); `arc` turns around them on the way. */
export function frameIds(scene: MapScene, ids: Iterable<ElementId>, { dur = 1000, arc = false, ...shot }: ShotOptions & { dur?: number; arc?: boolean } = {}): Shot | null {
    stopShots(scene);
    const s = shotOf(scene, ids, shot);
    if (s) fly(scene, s.toT, s.toC, dur, { arc });
    return s;
}

/**
 * Cinema: the camera rides along a relation — the target follows the curve from its start to its end, `keep` of
 * the offset it had from the curve's start stays (the framing: lift, room for a card), the rest melts away; the
 * distance goes to `dist`. A bright comet runs along with it.
 */
export function trackCurve(scene: MapScene, edgeId: string, dur: number, dist?: number | null, { keep = null, from = 0, to = 1 }: { keep?: THREE.Vector3 | null; from?: number; to?: number } = {}): boolean {
    const v = scene.edges.get(edgeId);
    if (!v || !scene.motion) return false; // reduced motion: the caller cuts to the end instead
    stopShots(scene);
    const off = scene.controls.target.clone().sub(v.curve.getPointAt(from));
    if (keep) off.sub(keep);
    const rel = scene.camera.position.clone().sub(scene.controls.target);
    scene.track = { from, to, curve: v.curve, t0: performance.now(), dur, off, keep: keep?.clone() ?? new THREE.Vector3(), dir: rel.clone().normalize(), d0: rel.length(), d1: dist ?? rel.length() };
    scene.drift = null;
    makeComet(scene, v, dur);
    scene.comet!.mesh.position.copy(v.curve.getPointAt(from));
    scene.dirty = true;
    return true;
}

export function stepTrack(scene: MapScene, now: number): void {
    const tr = scene.track!;
    const t = Math.max(0, Math.min(1, (now - tr.t0) / tr.dur));
    const u = t;
    const position = tr.from + (tr.to - tr.from) * u;
    scene.controls.target.copy(tr.curve.getPointAt(position)).add(tr.keep).addScaledVector(tr.off, 1 - u);
    scene.camera.position.copy(scene.controls.target).addScaledVector(tr.dir, tr.d0 + (tr.d1 - tr.d0) * u);
    if (scene.comet) scene.comet.mesh.position.copy(tr.curve.getPointAt(position));
    scene.dirty = true;
    if (t >= 1) {
        scene.track = null;
        dropComet(scene);
    }
}

export function makeComet(scene: MapScene, v: EdgeView, _dur: number): void {
    dropComet(scene);
    const mesh = new THREE.Points(scene.pulseGeo, new THREE.PointsMaterial({ color: scene.kinds[v.edge.group].color, size: 18, sizeAttenuation: false, map: scene.pulseDot, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.position.copy(v.curve.getPointAt(0));
    scene.group.add(mesh);
    scene.comet = { mesh };
}

export function dropComet(scene: MapScene): void {
    if (!scene.comet) return;
    scene.group.remove(scene.comet.mesh);
    scene.comet.mesh.material.dispose();
    scene.comet = null;
}

/**
 * Cinema: a slow move while a step is read — the view turns `turn` rad around the target and comes `dolly` closer
 * over `dur`; it starts softly, then goes at an even pace.
 */
export function driftFor(scene: MapScene, dur: number, { turn = 0.08, dolly = 0.06 }: { turn?: number; dolly?: number } = {}): void {
    if (!scene.motion) return;
    scene.drift = { t0: performance.now(), dur, turn, dolly, k: 0 };
    scene.dirty = true;
}

export function stepDrift(scene: MapScene, now: number): void {
    const d = scene.drift!;
    const t = Math.max(0, Math.min(1, (now - d.t0) / d.dur));
    const a = 0.2; // the first fifth eases in
    const k = (t < a ? (t * t) / (2 * a) : t - a / 2) / (1 - a / 2);
    const dk = k - d.k;
    d.k = k;
    const rel = scene.camera.position.clone().sub(scene.controls.target);
    rel.applyAxisAngle(new THREE.Vector3(0, 1, 0), d.turn * dk).multiplyScalar(1 - d.dolly * dk);
    scene.camera.position.copy(scene.controls.target).add(rel);
    scene.dirty = true;
    if (t >= 1) scene.drift = null;
}

/** Stops what the cinema has the camera doing (a ride, a drift, a flight). */
export function stopShots(scene: MapScene, { keepComet = false }: { keepComet?: boolean } = {}): void {
    scene.track = scene.drift = null;
    if (!keepComet) dropComet(scene);
    if (scene.cam) {
        scene.cam = null;
        scene.controls.enableZoom = true;
    }
}

/** Pans (same distance and angle) so that these nodes are in frame, if any of them is not. */
export function keepInFrame(scene: MapScene, ids: Iterable<ElementId>): void {
    const box = new THREE.Box3();
    let out = false;
    for (const id of ids) {
        const v = scene.nodes.get(id);
        if (!v) continue;
        const b = new THREE.Box3().setFromObject(v.body, false);
        box.union(b);
        const p = b.getCenter(new THREE.Vector3()).project(scene.camera);
        if (p.z > 1 || Math.abs(p.x) > 0.85 || Math.abs(p.y) > 0.8) out = true;
    }
    if (!out || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const d = c.clone().sub(scene.controls.target);
    fly(scene, c, scene.camera.position.clone().add(d));
}

/** Camera distance along `dir` from `c` at which the corners of `box` fill ~95% of the frame (a few secant steps). */
export function tightDistance(scene: MapScene, box: THREE.Box3, c: THREE.Vector3, dir: THREE.Vector3, dist: number): number {
    const cam = scene.camera.clone();
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const extent = (d: number) => {
        cam.position.copy(c).add(dir.clone().multiplyScalar(d));
        cam.lookAt(c);
        cam.updateMatrixWorld();
        let m = 0;
        for (const p of corners) {
            const q = p.clone().project(cam);
            m = Math.max(m, Math.abs(q.x), Math.abs(q.y));
        }
        return m;
    };
    for (let i = 0; i < 6; i++) dist *= Math.pow(extent(dist) / 0.95, 0.9);
    return dist;
}

/** Frame only these nodes (a focus and what it talks to). */
export function fitIds(scene: MapScene, ids: Set<ElementId>): void {
    fitAll(scene, false, ids);
}

export function flyTo(scene: MapScene, id: ElementId | null | undefined): void {
    if (!id) return fitAll(scene);
    const v = scene.nodes.get(id) || null;
    const target = v ? v.obj.position.clone() : new THREE.Vector3(0, 28, 0);
    const size = v ? Math.max(v.node._size.w, v.node._size.d) : 200;
    const dist = Math.max(70, size * 1.8 + 30);
    const dir = scene.camera.position.clone().sub(scene.controls.target).normalize();
    const toCam = target.clone().add(dir.multiplyScalar(dist));
    fly(scene, target, toCam);
}

export function preset(scene: MapScene, name: string): void {
    const t = scene.controls.target.clone();
    const toC = name === 'top' ? new THREE.Vector3(t.x, t.y + 330, t.z + 0.01) : name === 'side' ? new THREE.Vector3(t.x, t.y + 10, t.z + 300) : new THREE.Vector3(t.x - 130, t.y + 130, t.z + 190);
    fly(scene, t.clone(), toC);
}

/** The app changed the focus level from the wheel: the rest of a running pinch gesture no longer zooms. */
export function levelChanged(scene: MapScene): void {
    scene.controls.limitPinch.hold();
}
