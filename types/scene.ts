// Hand-written shapes of the scene's interface (viewer/src/scene.ts `MapScene` and its scene-*.ts modules) that main.ts uses: what the view asks
// the scene to show, what the pointer hit, what the wheel did, the counts after a frame, the callbacks. The scene's own
// state (three.js objects per node and relation, tweens, fades) is local to the scene (viewer/src/scene-types.ts). Types only: nothing here runs.
import type { Vector3 } from 'three';
import type { ElementId } from './spec.d.ts';
import type { Chip } from './viewer.ts';

/** `MapScene.setView`: what is shown, dimmed, lit and numbered. Every field may be left out (nothing special). */
export interface SceneView {
    /** Ids drawn normally while a focus is on (others become ghosts), or null. */
    keep?: Set<ElementId> | null;
    /** Folded edge ids that are drawn at all, or null for every edge. */
    edges?: Set<string> | null;
    /** Ids of the selected/hovered thing and its neighbours, or null. */
    lit?: Set<ElementId> | null;
    /** Edges of the selected/hovered thing. */
    litEdges?: Set<string> | null;
    /** The way from the last scenario step: drawn, quieter than the step. */
    bridge?: Set<string> | null;
    focus?: ElementId | null;
    /** Path or scenario step numbers on blocks (`▶` marks the start). */
    steps?: Map<ElementId, string | number> | null;
    /** Scenario step numbers on relations. */
    edgeSteps?: Map<string, string | number> | null;
    /** A scenario step lights softly: the picture around it stays readable. */
    soft?: boolean;
    /** Metric coloring, 0…1 per block, or null (by kind). */
    tint?: Map<ElementId, number> | null;
    /** Envelope chips per folded edge id (envelopes.ts `chipsOf`), or null. */
    env?: Map<string, Chip[]> | null;
}

/** What is under the pointer: a block, a relation (folded edge id), a layer field or an envelope chip (key + its edge). */
export interface Hit {
    type: 'node' | 'edge' | 'layer' | 'envelope';
    id: string;
    edge?: string;
    width?: number;
}

/** A screen point in client px. */
export interface ScreenPoint {
    x: number;
    y: number;
}

/** The last wheel event that zoomed: when, which way, where. */
export interface WheelInfo extends ScreenPoint {
    t: number;
    dir: 'in' | 'out';
}

/** Counts after a drawn frame (the status line). */
export interface SceneStats {
    nodes: number;
    inView: number;
    labels: number;
    edges: number;
    edgeLabels?: number;
    envelopes?: number;
}

/** The app's callbacks. */
export interface SceneHandlers {
    hover: (hit: Hit | null, at?: ScreenPoint) => void;
    click: (hit: Hit | null, at: ScreenPoint & { touch: boolean }) => void;
    toggle: (id: ElementId) => void;
    /** While the wheel moves the camera, every ~100 ms: the app decides the zoom level. */
    zoom?: (wheel: WheelInfo) => void;
    /** The person takes the camera (drag, two-finger pan). */
    cameraStart?: () => void;
    stats?: (s: SceneStats) => void;
}

/** `MapScene.shotOf`: where the camera goes to show some nodes. */
export interface Shot {
    toT: Vector3;
    toC: Vector3;
    dist: number;
    /** Where the target is from the subject. */
    off: Vector3;
}

/** `MapScene.shotOf` options. */
export interface ShotOptions {
    pad?: number;
    turn?: number;
    lift?: number;
    shiftX?: number;
    minR?: number;
}
