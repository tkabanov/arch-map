// The relations: lines with their names, the envelope chips on them, the pulses along what is lit.
import * as THREE from 'three';
import { KINDS, lineStyle } from './model.ts';
import { hasPolicies, shownFields, SIDE_TITLE } from './envelopes.ts';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { esc } from './scene-util.ts';
import { sceneColors } from './theme.ts';
import type { MapScene } from './scene.ts';
import type { ChipView, EdgeView, Label, LabelEl } from './scene-types.ts';
import type { Chip, FoldedEdge, Model, PlacedNode, RoutedEdge } from '../../types/viewer.ts';

const LOCK_SVG = '<svg class="lk" viewBox="0 0 12 14" width="10" height="12" aria-hidden="true"><path d="M3.5 6.2V4.3a2.5 2.5 0 0 1 5 0v1.9" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="1.5" y="6.2" width="9" height="6.8" rx="1.6" fill="currentColor"/></svg>';

function edgeCurve(a: PlacedNode, b: PlacedNode, k: number): THREE.CubicBezierCurve3 {
    // a rail is reached where the other end stands over it (a bus: each block drops straight onto it), not at its middle
    const xOf = (n: PlacedNode, other: PlacedNode) => {
        const cx = n._pos.x + n._size.w / 2;
        if (!n._rail) return cx;
        const ox = other._pos.x + other._size.w / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 1.2; // parallel lines apart
        return Math.max(n._pos.x + 1, Math.min(n._pos.x + n._size.w - 1, ox));
    };
    const ca = new THREE.Vector3(xOf(a, b), a._pos.y + a._size.h, a._pos.z + a._size.d / 2);
    const cb = new THREE.Vector3(xOf(b, a), b._pos.y + b._size.h, b._pos.z + b._size.d / 2);
    const dy = a._pos.y - b._pos.y;
    if (Math.abs(dy) > 6) {
        // between layers: leave from the bottom of the upper node, arrive on top of the lower one
        const start = dy > 0 ? new THREE.Vector3(ca.x, a._pos.y, ca.z) : ca;
        const end = dy > 0 ? cb : new THREE.Vector3(cb.x, b._pos.y, cb.z);
        const s = Math.sign(dy) * Math.abs(dy) * 0.45;
        const off = k * 1.6;
        return new THREE.CubicBezierCurve3(start, new THREE.Vector3(start.x + off, start.y - s, start.z), new THREE.Vector3(end.x + off, end.y + s, end.z), end);
    }
    const dist = ca.distanceTo(cb);
    const lift = 2.5 + dist * 0.22 + k * 2.2;
    return new THREE.CubicBezierCurve3(ca, ca.clone().add(new THREE.Vector3(0, lift, 0)), cb.clone().add(new THREE.Vector3(0, lift, 0)), cb);
}

/** Dash of a line in world units (spec 1.4 `edgeStyles[].dash`). */
const DASH: Record<string, { dashed?: boolean; dashSize?: number; gapSize?: number }> = {
    solid: {},
    dashed: { dashed: true, dashSize: 1.6, gapSize: 1.1 },
    dotted: { dashed: true, dashSize: 0.35, gapSize: 0.75 },
};

/** REST counts endpoints, the rest count relations. */
export function edgeCount(e: Pick<FoldedEdge, 'group' | 'raw'>): number {
    if (e.group !== 'rest') return e.raw.length;
    return new Set(e.raw.flatMap((r) => r.items.map((i) => i.split(' ← ')[0]))).size;
}

function edgeTitle(e: FoldedEdge, n: number): string {
    const g = KINDS[e.group];
    if (e.raw.length === 1 && n === 1) {
        const r = e.raw[0];
        const k = shortKind(r.kind);
        // «webhook: payment status», not «webhook webhook: payment status»
        if (['rest', 'event', 'webhook', 'https', 'call', 'interacts'].includes(r.kind)) return (r.title?.toLowerCase().startsWith(k.toLowerCase()) ? r.title : `${k} ${r.title}`).trim();
    }
    return e.group === 'ext' ? [...new Set(e.raw.map((r) => shortKind(r.kind)))].join(' / ') : g.title.split(' ')[0];
}

const shortKind = (k: string): string =>
    ({ rest: 'REST', read: 'read', write: 'write', event: 'event', trigger: 'trigger', schedule: 'schedule', webhook: 'webhook', https: 'HTTPS', smtp: 'SMTP', call: 'call', import: 'import', references: 'FK', interacts: '' } as Record<string, string>)[k] ?? k;

// ---------- edges ----------
export function clearEdges(scene: MapScene): void {
    for (const v of scene.edges.values()) {
        for (const o of [v.tube, v.hit]) {
            scene.group.remove(o);
            o.geometry.dispose();
            o.material.dispose();
        }
        v.label.element.remove();
        scene.group.remove(v.label);
    }
    scene.edges.clear();
    scene.hitCache = null;
    syncChips(scene, null);
}

export function buildEdges(scene: MapScene, folded: RoutedEdge[], _model?: Model): void {
    const had = new Set(scene.edges.keys()); // rebuilt in place: these were on screen, they don't fade in again
    clearEdges(scene);
    const pairIndex = new Map<string, number>();
    for (const e of folded) {
        const a = scene.nodes.get(e.from)?.node;
        const b = scene.nodes.get(e.to)?.node;
        if (!a || !b) continue;
        const pair = [e.from, e.to].sort().join('|');
        const k = pairIndex.get(pair) ?? 0;
        pairIndex.set(pair, k + 1);
        const curve = edgeCurve(a, b, k);
        // a line of constant pixel width: thin from far and from close; dim at the start, bright at the end
        const width = Math.min(3.2, 1.1 + 0.55 * Math.log2(1 + edgeCount(e)));
        const color = scene.kinds[e.group].color;
        const pts = curve.getPoints(48);
        const geo = new LineGeometry();
        geo.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
        const c = new THREE.Color(color);
        const from = sceneColors(scene.theme).lineFrom; // a light page: the line fades in from the page, not from black
        const bg = from ? new THREE.Color(from) : null;
        geo.setColors(pts.flatMap((_, i) => {
            const k = 0.28 + 0.72 * (i / (pts.length - 1));
            if (bg) { const m = bg.clone().lerp(c, 0.35 + 0.65 * (i / (pts.length - 1))); return [m.r, m.g, m.b]; }
            return [c.r * k, c.g * k, c.b * k];
        }));
        const { dash, planned } = lineStyle(e);
        const mat = new LineMaterial({ vertexColors: true, linewidth: width, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false, ...DASH[dash] });
        mat.resolution.copy(scene.lineRes);
        const tube = new Line2(geo, mat);
        if (dash !== 'solid') tube.computeLineDistances();
        tube.userData = { type: 'edge', id: e.id, width };
        const hit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
        hit.userData = { type: 'edge', id: e.id };
        scene.group.add(tube, hit);
        const el = document.createElement('div');
        el.className = `elabel g-${e.group}`;
        el.dataset.edge = e.id;
        el.style.setProperty('--c', color);
        const n = edgeCount(e);
        // a lock: rows of this relation are guarded by row-level policies (AD-9)
        const lock = hasPolicies(e.raw);
        if (lock) {
            el.classList.add('locked');
            el.title = 'Rows are protected by policies (RLS)';
        }
        el.innerHTML = `${lock ? LOCK_SVG : ''}<em>${esc(edgeTitle(e, n))}</em><span>${n > 1 ? ` · ${n}` : ''}</span>`;
        const label = new CSS2DObject(el) as Label;
        label.position.copy(curve.getPointAt(0.5));
        scene.group.add(label);
        if (planned) el.classList.add('planned');
        scene.edges.set(e.id, { edge: e, tube, hit, label, curve, mat, width, lock, planned, pts: curve.getPoints(24), fresh: !had.has(e.id) });
    }
    scene.applyView();
    scene.edgeFade = performance.now();
    scene.dirty = true;
}

// ---------- envelopes: what travels on a relation ----------
/**
 * `env`: folded edge id → chips [{ side, env: { key, title, fields, total }, others }] (envelopes.js chipsOf), or null.
 * Request sits near the caller (30% along the line), response near the callee (70%). Each chip carries both forms:
 * the name, and the name with its fields; cullLabels picks the form by how long the line is on screen.
 */
export function syncChips(scene: MapScene, env: Map<string, Chip[]> | null | undefined): void {
    const want = new Map<string, { v: EdgeView; c: Chip }>();
    for (const [id, chips] of env ?? []) {
        const v = scene.edges.get(id);
        if (!v) continue;
        for (const c of chips) want.set(`${id}|${c.side}`, { v, c });
    }
    for (const [k, ch] of scene.chips) if (!want.has(k)) {
        ch.el.remove();
        scene.group.remove(ch.obj);
        scene.chips.delete(k);
    }
    for (const [k, { v, c }] of want) {
        const { fields, more } = shownFields(c.env);
        const html =
            `<div class="eh"><i>${SIDE_TITLE[c.side]}</i><b>${esc(c.env.title)}</b>${c.others ? `<em>+${c.others}</em>` : ''}</div>` +
            (fields.length ? `<ul>${fields.map((f) => `<li>${esc(f.label)}</li>`).join('')}${more ? `<li class="more">${more} more</li>` : ''}</ul>` : '');
        let ch = scene.chips.get(k);
        if (!ch) {
            const el: LabelEl = document.createElement('div');
            const obj = new CSS2DObject(el);
            scene.group.add(obj);
            ch = { el, obj } as ChipView; // the rest is assigned right below
            scene.chips.set(k, ch);
        }
        Object.assign(ch, { v, side: c.side, key: c.env.key, hasFields: fields.length > 0 });
        ch.t = c.side === 'request' ? 0.3 : 0.7;
        ch.obj.position.copy(v.curve.getPointAt(ch.t));
        if (ch.html !== html) {
            ch.html = html;
            ch.el.innerHTML = html;
            ch.el._m = null;
        }
        ch.el.className = `envlabel ${c.side}${c.env.authored ? '' : ' tech'}`;
        ch.el.dataset.env = c.env.key;
        ch.el.dataset.of = v.edge.id;
        ch.el.title = `${c.side === 'request' ? 'Request' : 'Response'}: ${c.env.title}${c.others ? ` and ${c.others} more` : ''} — click to see where else it travels`;
        ch.el.style.setProperty('--c', scene.kinds[v.edge.group].color);
    }
}

// ---------- data pulses along the relations of what is selected ----------
export function clearPulses(scene: MapScene): void {
    for (const p of scene.pulses) {
        scene.group.remove(p.mesh);
        p.mesh.material.dispose();
    }
    scene.pulses = [];
}

export function makePulses(scene: MapScene, lit: Set<string> | null | undefined): void {
    clearPulses(scene);
    if (!lit || scene.pulsesOn === false) return;
    let n = 0;
    for (const id of lit) {
        const v = scene.edges.get(id);
        if (!v || v.hidden || n > 40) continue;
        const count = Math.min(4, 1 + Math.floor(Math.log2(1 + edgeCount(v.edge))));
        for (let i = 0; i < count; i++) {
            const mesh = new THREE.Points(scene.pulseGeo, new THREE.PointsMaterial({ color: scene.kinds[v.edge.group].color, size: 7, sizeAttenuation: false, map: scene.pulseDot, transparent: true, depthWrite: false, toneMapped: false }));
            scene.group.add(mesh);
            scene.pulses.push({ mesh, curve: v.curve, t: i / count, speed: 0.22 + Math.random() * 0.06 });
        }
        n++;
    }
}
