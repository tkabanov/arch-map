// What the view asks of the scene (focus, selection, lit and dimmed things, step numbers, metric colors), applied to the
// nodes and relations that are drawn. Split from `MapScene.applyView` of scene.ts; the expressions are the same.
import * as THREE from 'three';
import type { MapScene } from './scene.ts';
import type { EdgeView, NodeView } from './scene-types.ts';
import type { SceneView } from '../../types/scene.ts';
import type { ElementId } from '../../types/spec.d.ts';
import { sceneColors } from './theme.ts';

// cold → hot, for metric coloring (the map's own theme; its colors made on first use)
function ramp(scene: MapScene, t: number): THREE.Color {
    const RAMP = (scene.rampColors ??= sceneColors(scene.theme).ramp.map((c) => new THREE.Color(c)));
    const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(x));
    return RAMP[i].clone().lerp(RAMP[i + 1], x - i);
}

export function applyView(scene: MapScene): void {
    const vw: SceneView = scene.view ?? {};
    for (const [id, v] of scene.nodes) {
        dimNode(vw, id, v);
        glowNode(scene, vw, id, v);
        labelNode(scene, vw, id, v);
        tintNode(scene, vw, id, v);
    }
    // many lines at rest are a texture, not a message: past DENSE lines each gets fainter, so a lit route stands out
    // Past VERY_DENSE (a module of 67 reusable blocks: 231 lines) √ is not enough: the lines fade with the cube of the excess.
    const DENSE = 50, VERY_DENSE = 200;
    const n = Math.max(DENSE, scene.edges.size);
    const density = Math.min(1, Math.sqrt(DENSE / n)) * Math.min(1, (VERY_DENSE / n) ** 3);
    for (const [id, v] of scene.edges) styleEdge(scene, vw, id, v, density);
    scene.hitCache = null; // ghosts and hidden relations are not picked
    scene.syncChips(vw.env);
    scene.makePulses(vw.bridge?.size ? new Set([...(vw.litEdges ?? []), ...vw.bridge]) : vw.litEdges);
    scene.opacityMoving = true;
    scene.dirty = true;
}

/** Ghosts (outside the focus) and dimmed blocks (outside what is lit): the opacity the materials ease toward. */
function dimNode(vw: SceneView, id: ElementId, v: NodeView): void {
    const plate = v.node._plate;
    const ghost = !!vw.keep && !vw.keep.has(id);
    const dim = !ghost && !!vw.lit && !vw.lit.has(id) && !plate;
    const k = (v.node.context ? 0.5 : 1) * (ghost ? (plate ? 0.3 : 0.07) : dim ? (vw.soft ? 0.5 : 0.3) : 1);
    v.ghost = ghost;
    for (const e of v.mats) {
        e.view = e.base * k; // stepOpacity eases toward it
        e.m.depthWrite = !ghost && e.base * k > 0.6;
    }
}

/** The glow of the selected block, the focus and a block of the scenario step. */
function glowNode(scene: MapScene, vw: SceneView, id: ElementId, v: NodeView): void {
    const plate = v.node._plate;
    const sel = scene.selected === id || vw.focus === id;
    const step = vw.soft && !plate && vw.lit?.has(id); // a block of the current scenario step: lit in its own color
    if (v.emissive.emissive) {
        v.baseEmissive ??= { c: v.emissive.emissive.clone(), i: v.emissive.emissiveIntensity };
        scene.accentColor ??= new THREE.Color(sceneColors(scene.theme).select);
        v.emissive.emissive.copy(sel ? scene.accentColor : v.baseEmissive.c);
        v.emissive.emissiveIntensity = sel ? (plate ? 0.15 : 0.5) : step ? 0.55 : v.baseEmissive.i;
    }
}

/** The name's classes (lit, selected) and the number of the path step. */
function labelNode(scene: MapScene, vw: SceneView, id: ElementId, v: NodeView): void {
    const step = vw.soft && !v.node._plate && vw.lit?.has(id);
    v.label.element.classList.toggle('lit', !!step);
    v.label.element.classList.toggle('sel', scene.selected === id);
    v.label.element.classList.toggle('unlit', !!vw.lit && !vw.soft && !step && !vw.lit.has(id) && !v.node._plate && scene.selected !== id && vw.focus !== id); // named, but not what the selection is about
    // number of the path step, and a metric color
    if (vw.steps?.has(id)) v.label.element.dataset.step = String(vw.steps.get(id));
    else delete v.label.element.dataset.step;
}

/** The metric color (or the block's own). */
function tintNode(scene: MapScene, vw: SceneView, id: ElementId, v: NodeView): void {
    if (!v.baseColor) v.baseColor = v.emissive.color.clone();
    const t = !v.node._plate && vw.tint ? vw.tint.get(id) : undefined;
    v.emissive.color.copy(t === undefined ? v.baseColor : ramp(scene, t));
}

/** A relation: drawn or not, how strongly (lit, on the way from the last step, at rest), how wide, its step number. */
function styleEdge(scene: MapScene, vw: SceneView, id: string, v: EdgeView, density: number): void {
    const shown = !vw.edges || vw.edges.has(id);
    const lit = !!vw.litEdges && vw.litEdges.has(id);
    const via = !lit && !!vw.bridge?.has(id); // the way from the last scenario step: drawn, quieter than the step
    const op = !shown ? 0 : via ? 0.72 : vw.litEdges ? (lit ? 0.9 : vw.soft ? 0.1 : 0.05) : (vw.focus ? 0.6 : 0.32) * density;
    v.tube.visible = shown;
    v.op = op; // the fade-in after a rebuild scales this
    v.mat.opacity = op;
    v.mat.linewidth = lit ? v.width * 1.6 : via ? v.width * 1.25 : v.width; // the selected thing's relations stand out by width, not glow
    v.hit.visible = shown;
    v.hidden = !shown;
    v.label.element.classList.toggle('sel', scene.selected === id);
    // the number of the scenario step this relation belongs to
    if (vw.edgeSteps?.has(id)) v.label.element.dataset.step = String(vw.edgeSteps.get(id));
    else delete v.label.element.dataset.step;
}
