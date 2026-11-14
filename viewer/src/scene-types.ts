// The scene's own state (scene.ts and its scene-*.ts modules): what each block and relation is on the map (three.js
// objects, labels), the running tweens, fades and camera flights, and the label candidates. Here, not in types/, because
// it names DOM types (the Node project of check:tsc has no DOM); what main.ts uses of the scene is in types/scene.ts.
// Types only: nothing here runs.
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type * as THREE from 'three';
import type { Plate } from './layout.ts';
import type { Visual } from './shapes.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { PlacedNode, RoutedEdge, Side } from '../../types/viewer.ts';
import type { MapScene } from './scene.ts';

/** A scene function taken off `MapScene`: its arguments after the scene (the delegates in scene.ts repeat them). */
export type Rest<F> = F extends (scene: MapScene, ...a: infer A) => unknown ? A : never;

/** A label's element with the caches cullLabels keeps on it: sizes per class list, class lists, the shift, the placed box. */
export type LabelEl = HTMLElement & { _m?: Map<string, LabelSize> | null; _cn?: string; _cl?: Map<string, string>; _t?: string; _r?: number[] };
export type Label = CSS2DObject & { element: LabelEl };
export interface LabelSize {
    w: number;
    h: number;
}
/** A material and the opacity it had when a fade started. */
export interface FadeMat {
    m: THREE.Material;
    from: number;
}
/** Something with a geometry and a material (a mesh, lines, points), as `traverse` meets it. */
export type Drawable = THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material };
/** The old visual of a block that opens or closes in place, while it turns into the new one. */
export interface Morph {
    obj: THREE.Group;
    mats: FadeMat[];
    s0: THREE.Vector3;
    sc0: THREE.Vector3;
    s1: THREE.Vector3;
    d0: THREE.Vector3;
    ob: THREE.Vector3;
}
/** A node on the map: its layout node, its visual, its name, and what the view and the running change do to it. */
export interface NodeView extends Visual {
    node: PlacedNode;
    label: Label;
    /** `plate|w|h|d`: the visual is rebuilt when it changes. */
    sz?: string;
    plate?: boolean;
    morph?: Morph | null;
    fade?: number;
    /** Truthy while a running change fades it. */
    fading?: boolean | Morph | null;
    ghost?: boolean;
    baseColor?: THREE.Color;
    baseEmissive?: { c: THREE.Color; i: number } | null;
}
/** A drawn relation: the line, an invisible fatter twin for the pointer, its name. */
export interface EdgeView {
    edge: RoutedEdge;
    tube: Line2;
    hit: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    label: Label;
    curve: THREE.CubicBezierCurve3;
    mat: LineMaterial;
    width: number;
    lock: boolean;
    pts: THREE.Vector3[];
    fresh: boolean;
    op?: number;
    hidden?: boolean;
    len?: number;
    t?: number;
}
/** An envelope chip on a relation. */
export interface ChipView {
    el: LabelEl;
    obj: CSS2DObject;
    v: EdgeView;
    side: Side;
    key: string;
    hasFields: boolean;
    t?: number | null;
    html?: string;
}
/** A layer field and its name. */
export interface PlateView {
    mesh: THREE.Group;
    label: Label;
    p: Plate;
}
/** One node's part of a layout change. */
export interface Tween {
    v: NodeView;
    from: THREE.Vector3 | null | undefined;
    to: THREE.Vector3;
    fade0: number;
    morph?: Morph | null;
    s0?: THREE.Vector3;
    /** A part growing out of (or going back into) the block it is in: placed relative to that block's tween. */
    src?: { tw: Tween; rel: THREE.Vector3; g0: number; g1: number };
    leave?: boolean;
}
export interface Anim {
    t0: number;
    dur: number;
    tweens: Tween[];
    camDelta: THREE.Vector3 | null;
    kPrev: number;
    done: () => unknown;
}
export interface Fade {
    out: boolean;
    objs: THREE.Object3D[];
    labels: Label[];
    mats: FadeMat[];
    t0: number;
    dur: number;
}
export interface CamFlight {
    t0: number;
    dur: number;
    fromT: THREE.Vector3;
    toT: THREE.Vector3;
    fromC: THREE.Vector3;
    toC: THREE.Vector3;
    vT: THREE.Vector3;
    vC: THREE.Vector3;
    arc?: { a: THREE.Spherical; dth: number; dphi: number; lr: number };
}
export interface Track {
    from: number;
    to: number;
    curve: THREE.CubicBezierCurve3;
    t0: number;
    dur: number;
    off: THREE.Vector3;
    keep: THREE.Vector3;
    dir: THREE.Vector3;
    d0: number;
    d1: number;
}
export interface Drift {
    t0: number;
    dur: number;
    turn: number;
    dolly: number;
    k: number;
}
export interface Preview {
    id: ElementId;
    shown: number;
    target: number;
    base: number;
    fading?: boolean;
    done?: number;
}
export type PointsMesh = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
export interface Pulse {
    mesh: PointsMesh;
    curve: THREE.CubicBezierCurve3;
    t: number;
    speed: number;
}
/** A label to place: its options (screen box, how to apply it), its priority, and what kind it is. */
export interface Candidate {
    obj: CSS2DObject;
    opts: LabelOption[];
    prio: number;
    rest?: boolean;
    edge?: boolean;
    env?: boolean;
    layerName?: boolean;
}
export interface LabelOption {
    rect: number[];
    apply?: () => unknown;
    layerName?: boolean;
    clearOfBodies?: boolean;
    /** A block's name: the spot must cover the middle of no block but this one (in a dense grid a name over its neighbour reads as the neighbour's). */
    clearOf?: ElementId;
    /** The spot must not cover the middle (where the pointer picks it, scene-pick `atCentre`) of any block but this one. */
    clearOfCore?: ElementId;
}
/** What `pick` reads of a pointer event. */
export interface PickEvent {
    clientX: number;
    clientY: number;
    target: EventTarget | null;
}
