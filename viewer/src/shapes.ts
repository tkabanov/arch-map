// What each node looks like, by its glyph `shape` (spec-adapter.js shapeOf: facet first, core type fallback): thin glass tiles with a glowing outline and a line glyph on top.
// Light, not volume: color says what it is, a few lines say how it works. Built in world units at the node's size.
// `detail` holds the fine parts that are hidden when the node is small on screen.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PlacedNode, ViewNode } from '../../types/viewer.ts';
import { ink, sceneColors, type Theme } from './theme.ts';

/** Something drawn with one material (a mesh, lines, points): what `add` collects with its base opacity. */
type Drawn = THREE.Object3D & { material: THREE.Material };
/** The visual of a node: its group, the body the pointer hits, the fine parts, every material with its base opacity. */
export interface Visual {
    obj: THREE.Group;
    body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    detail: THREE.Group;
    /** `view`: the opacity the view asks for, `cur`: the one shown now (scene-layout.ts `stepOpacity` eases one toward the other). */
    mats: { m: THREE.Material; base: number; view?: number; cur?: number }[];
    emissive: THREE.MeshStandardMaterial;
}

export const LAYER_ACCENT: Record<string, string> = { people: '#fcd34d', ui: '#6ea8ff', service: '#a78bfa', data: '#34d3a6' };
const SHAPE_COLOR: Record<string, string> = {
    endpoints: '#7cc4ff', core: '#a78bfa', stack: '#5eead4', grid: '#34d399', orbit: '#fb7185', frame: '#93c5fd',
    arrow: '#7cc4ff', ring: '#9fb0c8', person: '#fcd34d', clock: '#fbbf77', rail: '#fbbf77',
};
const MATRIX_COLOR: Record<string, string> = { system: '#8fb0e8', app: '#8fb0e8', module: '#b9a7ff', datastore: '#34d399', group: '#5b6678' };
/** What one map builds its visuals with: its theme and its own dot sprite (nothing is shared between two maps). */
export interface VisualKit {
    theme: Theme;
    /** a soft round sprite, made once per map (`dotTexture`) and disposed with it */
    dot: THREE.CanvasTexture;
}
/** Spec 1.4: a declared glyph's tone, instead of the glyph's color (the dark look's; `ink` deepens it on light). */
const TONE_COLOR: Record<string, string> = { ok: '#34d399', warn: '#fbbf24', bad: '#fb7185', muted: '#6b7280' };
/** Color of a node: its declared tone; else by glyph; a matrix (something with parts) by core type, a folder grouping lighter. */
export const colorOf = (n: Pick<ViewNode, 'shape' | 'type' | 'derivedFrom' | 'tone'>, theme: Theme): string => ink(
    n.tone ? TONE_COLOR[n.tone] : n.shape === 'matrix' ? (n.type === 'module' && n.derivedFrom?.rule === 'folder' ? '#9fb0c8' : MATRIX_COLOR[n.type] ?? '#9fb0c8') : SHAPE_COLOR[n.shape] ?? '#9fb0c8', theme.mode);
const METHOD: Record<string, string> = { GET: '#34d399', POST: '#7cc4ff', PUT: '#fbbf77', PATCH: '#fbbf77', DELETE: '#fb7185' };

const glass = (theme: Theme, color: THREE.ColorRepresentation, opacity: number) =>
    new THREE.MeshStandardMaterial({ color: new THREE.Color(sceneColors(theme).glassBase).lerp(new THREE.Color(color), sceneColors(theme).glassMix), roughness: 0.2, metalness: 0.1, transparent: true, opacity, emissive: color, emissiveIntensity: 0.06, depthWrite: false });
const line = (color: THREE.ColorRepresentation, opacity: number) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, toneMapped: false });
const light = (color: THREE.ColorRepresentation, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, toneMapped: false });
const pts = (color: THREE.ColorRepresentation, size: number, opacity: number) => new THREE.PointsMaterial({ color, size, sizeAttenuation: true, transparent: true, opacity, toneMapped: false, depthWrite: false });
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** A soft round sprite for the dots of a map's visuals (one per map: `VisualKit.dot`). */
export function dotTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
}
/** Points of a constant pixel size, one draw call, each with its own color. */
function dots(dot: THREE.CanvasTexture, positions: THREE.Vector3[], colors: THREE.ColorRepresentation[], px: number, opacity = 0.95) {
    const geo = new THREE.BufferGeometry().setFromPoints(positions);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors.flatMap((c) => { const k = new THREE.Color(c); return [k.r, k.g, k.b]; }), 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ size: px, sizeAttenuation: false, vertexColors: true, map: dot, transparent: true, opacity, depthWrite: false, toneMapped: false }));
}
const seg = (points: THREE.Vector3[]) => new THREE.BufferGeometry().setFromPoints(points);

export function buildVisual(n: PlacedNode, kit: VisualKit): Visual {
    const { theme } = kit;
    const sc = sceneColors(theme);
    const glassOf = (color: THREE.ColorRepresentation, opacity: number) => glass(theme, color, opacity);
    const { w, h, d } = n._size;
    const obj = new THREE.Group();
    const detail = new THREE.Group();
    const mats: Visual['mats'] = [];
    const add = <T extends Drawn>(o: T, toDetail = false): T => {
        mats.push({ m: o.material, base: o.material.opacity });
        (toDetail ? detail : obj).add(o);
        return o;
    };
    const color = colorOf(n, theme);
    let body: Visual['body'];

    if (n._column) {
        // an open system (AD-11): a tall pane of faint glass around its parts on every tier, a thin rim, bright corners on top
        const accent = colorOf(n, theme);
        body = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glassOf(accent, 0.035)));
        add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), line(accent, 0.2)));
        const top = h / 2, k = Math.min(2.4, w / 6, d / 6);
        const ticks: THREE.Vector3[] = [];
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const x = sx * w / 2, z = sz * d / 2;
            ticks.push(V(x, top, z), V(x - sx * k, top, z), V(x, top, z), V(x, top, z - sz * k), V(x, top, z), V(x, top - k, z));
        }
        add(new THREE.LineSegments(seg(ticks), line(sc.tick, 0.7)));
        return finish();
    }

    if (n._rail) {
        // a cross-cutting rail (a bus, a queue, jobs): a long thin bar of light under its column, a bright line
        // along it and a slow beat of marks, so it reads as one channel the blocks above drop into
        const c = colorOf(n, theme);
        body = add(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(0.3, h / 2)), glassOf(c, 0.32)));
        body.material.emissiveIntensity = 0.22;
        add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), line(c, 0.75)));
        const top = h / 2 + 0.02;
        add(new THREE.LineSegments(seg([V(-w / 2 + 0.6, top, 0), V(w / 2 - 0.6, top, 0)]), line(sc.railLine, 0.85)));
        const marks: THREE.Vector3[] = [];
        for (let x = -w / 2 + 2; x < w / 2 - 1; x += 3) marks.push(V(x, top, -d * 0.3), V(x, top, d * 0.3));
        add(new THREE.LineSegments(seg(marks), line(c, 0.45)), true);
        return finish();
    }

    if (n._plate) {
        // a board: almost clear glass, a thin rim, a dot grid, four corner ticks
        const accent = ink(LAYER_ACCENT[n.layer] ?? '#9fb0c8', theme.mode);
        body = add(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(0.3, h / 2)), glassOf(accent, 0.1)));
        const top = h / 2 + 0.01;
        add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), line(accent, n.type === 'app' ? 0.35 : 0.5)));
        const grid: THREE.Vector3[] = [];
        for (let x = -w / 2 + 2; x < w / 2 - 1; x += 2) for (let z = -d / 2 + 4; z < d / 2 - 1; z += 2) grid.push(V(x, top, z));
        if (grid.length) add(new THREE.Points(seg(grid), pts(accent, 0.12, 0.35)), true);
        const k = Math.min(1.6, w / 8, d / 8);
        const ticks: THREE.Vector3[] = [];
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const x = sx * w / 2, z = sz * d / 2;
            ticks.push(V(x, top, z), V(x - sx * k, top, z), V(x, top, z), V(x, top, z - sz * k));
        }
        add(new THREE.LineSegments(seg(ticks), line(sc.tick, 0.8)));
        return finish();
    }

    // every block: a thin glass tile with a glowing outline
    const th = Math.max(0.35, h * 0.45); // tiles stay thin; height still grows a little with size
    const tw = w * 0.86, td = d * 0.82;
    // the client layer (a root: actor, system, external) is the picture people are shown first: brighter glass, a fuller
    // outline and a soft halo around the tile; the same look, a little more light
    const root = !n.parent && n.type !== 'app' && n.type !== 'datastore';
    body = add(new THREE.Mesh(new RoundedBoxGeometry(tw, th, td, 2, Math.min(0.25, th / 2)), glassOf(color, n.context ? 0.25 : root ? 0.5 : 0.42)));
    body.position.y = -h / 2 + th / 2;
    if (root) body.material.emissiveIntensity = 0.16;
    const top = -h / 2 + th + 0.02;
    const outline = add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(tw, th, td)), line(color, n.context ? 0.3 : root ? 0.9 : n.type === 'app' ? 0.45 : 0.62)));
    outline.position.y = body.position.y;
    if (root) {
        for (const [k, o] of [[1.05, 0.22], [1.11, 0.09]]) {
            const halo = add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(tw * k + (k - 1) * 6, td * k + (k - 1) * 6)), line(color, o)));
            halo.rotation.x = -Math.PI / 2;
            halo.position.y = -h / 2 + 0.02;
        }
    }
    const r = Math.min(tw, td) * 0.28; // glyph size
    const G = (points: THREE.Vector3[], opacity = 0.75, toDetail = false) => add(new THREE.LineSegments(seg(points), line(color, opacity)), toDetail);
    const ring = (cx: number, cz: number, rr: number, y = top, steps = 40) => {
        const p: THREE.Vector3[] = [];
        for (let i = 0; i < steps; i++) {
            const a = (i / steps) * Math.PI * 2, b = ((i + 1) / steps) * Math.PI * 2;
            p.push(V(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr), V(cx + Math.cos(b) * rr, y, cz + Math.sin(b) * rr));
        }
        return p;
    };
    const ellipse = (rx: number, rz: number, y: number) => {
        const p: THREE.Vector3[] = [];
        for (let i = 0; i < 36; i++) {
            const a = (i / 36) * Math.PI * 2, b = ((i + 1) / 36) * Math.PI * 2;
            p.push(V(Math.cos(a) * rx, y, Math.sin(a) * rz), V(Math.cos(b) * rx, y, Math.sin(b) * rz));
        }
        return p;
    };

    switch (n.shape) {
        case 'endpoints': {
            // ‹ › — an entry point; a dot per endpoint along the front edge, colored by method
            G([V(-r * 0.3, top, -r), V(-r * 1.1, top, 0), V(-r * 1.1, top, 0), V(-r * 0.3, top, r), V(r * 0.3, top, -r), V(r * 1.1, top, 0), V(r * 1.1, top, 0), V(r * 0.3, top, r)]);
            const eps = n.endpoints ?? [];
            const span = tw * 0.84;
            if (eps.length)
                add(dots(kit.dot, eps.map((_, i) => V(-span / 2 + (span * (i + 0.5)) / eps.length, top, td / 2 - 0.45)), eps.map((ep) => ink(METHOD[ep.method] ?? '#9fb0c8', theme.mode)), 5), true);
            break;
        }
        case 'core': {
            // a neuron: a ring and a bright core
            G(ring(0, 0, r));
            const core = add(new THREE.Mesh(new THREE.SphereGeometry(r * 0.22, 12, 10), light(color, 0.8)));
            core.position.y = top + 0.05;
            G(ring(0, 0, r * 1.6), 0.25, true);
            break;
        }
        case 'stack':
            // three stacked ellipses
            for (let i = 0; i < 3; i++) G(ellipse(r * 1.1, r * 0.55, top + i * 0.28), i === 2 ? 0.95 : 0.55);
            break;
        case 'grid': {
            // a grid: rows and columns
            const gx = r * 1.3, gz = r * 1.0;
            const p: THREE.Vector3[] = [];
            for (let i = 0; i <= 3; i++) p.push(V(-gx, top, -gz + (2 * gz * i) / 3), V(gx, top, -gz + (2 * gz * i) / 3));
            for (let i = 0; i <= 2; i++) p.push(V(-gx + gx * i, top, -gz), V(-gx + gx * i, top, gz));
            G(p, 0.85);
            break;
        }
        case 'orbit': {
            // an orbit around a core: something outside the system
            G(ring(0, 0, r * 1.2));
            G(ellipse(r * 1.7, r * 0.6, top + 0.02), 0.5, true);
            const core = add(new THREE.Mesh(new THREE.SphereGeometry(r * 0.3, 12, 10), light(color, 0.8)));
            core.position.y = top + 0.05;
            break;
        }
        case 'frame':
            // a screen frame
            G([V(-r * 1.3, top, -r * 0.9), V(r * 1.3, top, -r * 0.9), V(r * 1.3, top, -r * 0.9), V(r * 1.3, top, r * 0.6), V(r * 1.3, top, r * 0.6), V(-r * 1.3, top, r * 0.6), V(-r * 1.3, top, r * 0.6), V(-r * 1.3, top, -r * 0.9), V(-r * 0.4, top, r * 0.95), V(r * 0.4, top, r * 0.95)]);
            break;
        case 'arrow':
            // an arrow out
            G([V(-r * 1.2, top, 0), V(r * 1.1, top, 0), V(r * 1.1, top, 0), V(r * 0.5, top, -r * 0.6), V(r * 1.1, top, 0), V(r * 0.5, top, r * 0.6)]);
            break;
        case 'person': {
            // a head and shoulders: someone who uses the system
            G(ring(0, -r * 0.45, r * 0.42));
            const p: THREE.Vector3[] = [];
            for (let i = 0; i < 16; i++) {
                const a = Math.PI + (i / 16) * Math.PI, b = Math.PI + ((i + 1) / 16) * Math.PI;
                p.push(V(Math.cos(a) * r, top, r * 0.95 + Math.sin(a) * r * 0.85), V(Math.cos(b) * r, top, r * 0.95 + Math.sin(b) * r * 0.85));
            }
            G(p);
            break;
        }
        case 'clock':
            // a dial with two hands: something that runs on a schedule
            G(ring(0, 0, r));
            G([V(0, top, 0), V(0, top, -r * 0.7), V(0, top, 0), V(r * 0.5, top, 0)], 0.9);
            break;
        case 'ring':
            G(ring(0, 0, r * 0.5), 0.7);
            break;
        default:
            if (n.children.length) {
                // a matrix of points, one per part: density is visible before going in (a system shows its apps' parts)
                const kids = n.type === 'system' ? n.children.flatMap((c) => (c.children.length ? c.children : [c])) : n.children;
                const cols = Math.ceil(Math.sqrt(kids.length * (tw / td)));
                const rows = Math.ceil(kids.length / cols);
                const sx = (tw * 0.7) / Math.max(cols - 1, 1), sz = (td * 0.6) / Math.max(rows - 1, 1);
                add(dots(kit.dot,
                    kids.map((_, i) => V(cols > 1 ? -tw * 0.35 + sx * (i % cols) : 0, top + 0.05, rows > 1 ? -td * 0.3 + sz * Math.floor(i / cols) : 0)),
                    kids.map((c) => (c.context ? sc.context : colorOf(c, theme))),
                    6,
                ), true);
                if (n.type === 'group') outline.material.opacity = 0.3;
            } else G(ring(0, 0, r * 0.5), 0.7);
    }
    return finish();

    function finish() {
        obj.add(detail);
        body.userData = { type: 'node', id: n.id };
        return { obj, body, detail, mats, emissive: body.material };
    }
}

export function disposeVisual(v: Pick<Visual, 'obj'>): void {
    v.obj.traverse((obj) => {
        const o = obj as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        o.geometry?.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
    });
}
