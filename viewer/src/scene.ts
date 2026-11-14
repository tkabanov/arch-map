// three.js scene: blocks and plates for visible nodes, tubes for folded relations, HTML labels with level of detail.
// Rendering is on demand: a frame is drawn only when the camera, the layout or the highlight changed.
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildVisual, dotTexture as visualDot, type VisualKit } from './shapes.ts';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { MapControls } from './scene-controls.ts';
import * as layout from './scene-layout.ts';
import * as pick from './scene-pick.ts';
import * as labels from './scene-labels.ts';
import * as edges from './scene-edges.ts';
import { edgeCount } from './scene-edges.ts';
import * as camera from './scene-camera.ts';
import * as style from './scene-style.ts';
import * as frame from './scene-frame.ts';
import { MOVE_MS, esc } from './scene-util.ts';
import { sceneColors, type Theme } from './theme.ts';
import type { Kinds } from './model.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { PlacedNode } from '../../types/viewer.ts';
import type { Rest, Anim, CamFlight, ChipView, Drift, EdgeView, Fade, LabelEl, LabelSize, NodeView, PlateView, PointsMesh, Preview, Pulse, Track } from './scene-types.ts';
import type { SceneHandlers, SceneStats, SceneView, WheelInfo, ScreenPoint } from '../../types/scene.ts';

export { esc, edgeCount };

/** A round soft dot for points. */
function dotTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
}

/** A deep backdrop with a soft light in the upper middle. */
function backdrop(theme: Theme): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(256, 170, 20, 256, 256, 420);
    const [inner, mid, outer] = sceneColors(theme).backdrop;
    grad.addColorStop(0, inner);
    grad.addColorStop(0.55, mid);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/** What a map hands its scene: its own theme and relation colors, its lifetime, where its DOM lives, whose keys are its. */
export interface SceneEnv {
    theme: Theme;
    kinds: Kinds;
    /** aborted when the map is destroyed: every listener the scene adds outside its own elements goes with it */
    signal: AbortSignal;
    /** the shadow root (or the document) the map's elements are in: `elementFromPoint` asks it */
    root: DocumentOrShadowRoot;
}

/** Everything a scene object may hold that the GPU keeps: geometries, materials and their textures. */
function disposeTree(root: THREE.Object3D, textures: Set<THREE.Texture>): void {
    root.traverse((obj) => {
        const o = obj as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        o.geometry?.dispose();
        for (const m of [o.material ?? []].flat()) {
            for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v);
            m.dispose();
        }
    });
}

export class MapScene {
    // `declare`: types only — every field is set in the constructor or later, as before (no class-field semantics)
    declare container: HTMLElement;
    declare handlers: SceneHandlers;
    declare nodes: Map<ElementId, NodeView>;
    declare edges: Map<string, EdgeView>;
    declare plates: PlateView[];
    declare view: SceneView | null;
    declare selected: string | null;
    declare dirty: boolean;
    declare anim: Anim | null;
    declare fades: Fade[];
    declare camVel: { c: THREE.Vector3; t: THREE.Vector3 };
    declare opacityMoving: boolean;
    declare motion: boolean;
    declare renderer: THREE.WebGLRenderer;
    declare labels: CSS2DRenderer;
    declare measureEl: HTMLDivElement;
    declare mgen: number;
    declare chips: Map<string, ChipView>;
    declare scene: THREE.Scene;
    declare camera: THREE.PerspectiveCamera;
    declare controls: MapControls;
    declare pulses: Pulse[];
    declare pulseGeo: THREE.BufferGeometry;
    declare pulseDot: THREE.CanvasTexture;
    declare glow: boolean;
    declare composer: EffectComposer;
    declare bloom: UnrealBloomPass;
    declare boxGeo: THREE.BoxGeometry;
    declare edgeGeo: THREE.EdgesGeometry;
    declare group: THREE.Group;
    declare raycaster: THREE.Raycaster;
    declare pointer: THREE.Vector2;
    declare rectTmp: { x0: number; x1: number; y0: number; y1: number; behind: boolean };
    declare projScreen: THREE.Matrix4;
    declare toMeasure: { el: LabelEl; cls: string; key: string; pending: LabelSize }[];
    declare frustum: THREE.Frustum;
    declare stats: SceneStats;
    /** Rendered frames (debug API: idle means it does not grow). */
    declare frames: number;
    declare warm: THREE.Group;
    declare lineRes: THREE.Vector2;
    declare rect: DOMRect | null;
    declare hitCache: { all: THREE.Object3D[]; nodes: THREE.Object3D[]; bodies: THREE.Object3D[] } | null;
    declare worldOffset: THREE.Vector3;
    /** The block the wheel opens (or leaves): it stays where it is on screen (main.ts sets it). */
    declare anchor: ElementId | null;
    declare cam: CamFlight | null;
    declare track: Track | null;
    declare drift: Drift | null;
    declare comet: { mesh: PointsMesh } | null;
    declare edgeFade: number | null;
    declare preview: Preview | null;
    declare lastWheel: WheelInfo | null;
    /** Where the mouse last moved over the map (client px); null after a touch. */
    declare pointerAt?: ScreenPoint | null;
    /** The mouse buttons held now (`PointerEvent.buttons`; 0 when none). */
    declare pointerButtons?: number;
    /** The camera or the layout moved since the hover was last looked at under a still pointer (scene-frame.ts noticeRest). */
    declare moved?: boolean;
    /** When the camera stopped moving (performance.now()), while `moved`. */
    declare stillSince?: number | null;
    declare zoomEval: number;
    declare lastNow: number;
    declare lastCam: { c: THREE.Vector3; t: THREE.Vector3 };
    /** main.ts: pulses on relations (View menu). */
    declare pulsesOn: boolean;
    /** main.ts: the cinema plays — it names only what the step is about. */
    declare cinema: boolean;
    /** The map's theme and relation colors (each map has its own). */
    declare theme: Theme;
    declare kinds: Kinds;
    /** What the visuals are built with: the theme and this scene's own dot sprite. */
    declare kit: VisualKit;
    /** The selection glow and the metric ramp in the theme's colors (scene-style.ts, made on first use). */
    declare accentColor?: THREE.Color;
    declare rampColors?: THREE.Color[];
    declare signal: AbortSignal;
    declare root: DocumentOrShadowRoot;
    /** The frame loop's pending animation frame (cancelled by dispose). */
    declare raf: number;
    declare resizeWatch: ResizeObserver;
    /** Timers the scene set and has not seen fire (dom.ts `later`); `dead` once disposed: a late one does nothing. */
    declare timers: Set<number>;
    declare dead?: boolean;
    constructor(container: HTMLElement, handlers: SceneHandlers, env: SceneEnv) {
        this.container = container;
        this.handlers = handlers;
        this.theme = env.theme;
        this.kinds = env.kinds;
        this.signal = env.signal;
        this.root = env.root;
        this.timers = new Set();
        this.kit = { theme: env.theme, dot: visualDot() };
        this.nodes = new Map(); // id → { node, obj, body, detail, mats, label }
        this.edges = new Map(); // id → { edge, tube, cone, hit, label }
        this.plates = [];
        this.view = null;
        this.selected = null;
        this.dirty = true;
        this.anim = null;
        this.fades = []; // things fading out (old relations, layer fields) or in (new layer fields), on their own clock
        this.camVel = { c: new THREE.Vector3(), t: new THREE.Vector3() }; // camera and target velocity, units/ms
        this.opacityMoving = false;
        this.motion = true; // false (reduced motion): flights and layout changes are cuts, no drifts or rides

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        container.appendChild(this.renderer.domElement);
        this.labels = new CSS2DRenderer();
        this.labels.domElement.className = 'labels';
        container.appendChild(this.labels.domElement);
        // labels are placed by their real size: a hidden twin measures each label once per content and class
        this.measureEl = document.createElement('div');
        this.measureEl.style.cssText = 'position:absolute;left:0;right:0;top:0;visibility:hidden;pointer-events:none'; // as wide as the map: a twin wraps where its label would
        this.measureEl.setAttribute('aria-hidden', 'true');
        this.measureEl.dataset.measure = '1';
        this.labels.domElement.appendChild(this.measureEl);
        this.mgen = 0;
        document.fonts?.addEventListener?.('loadingdone', () => ((this.mgen++), (this.dirty = true)), { signal: this.signal });
        this.chips = new Map(); // `${edge id}|${side}` → { obj, el, edge, side, html }

        this.scene = new THREE.Scene();
        this.scene.background = backdrop(this.theme);
        this.scene.fog = new THREE.Fog(sceneColors(this.theme).fog, 420, 1000);
        this.camera = new THREE.PerspectiveCamera(30, 1, 1, 4000);
        this.camera.position.set(-120, 150, 210);
        this.controls = new MapControls(this.camera, this.labels.domElement, this.signal);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.12;
        this.controls.screenSpacePanning = true;
        this.controls.maxDistance = 1200;
        this.controls.target.set(0, 28, 0);
        this.controls.zoomToCursor = true;
        this.controls.zoomSpeed = 2.4; // a few wheel notches should be enough to go one level in
        // a fixed isometric look by default: drag pans, Shift + drag rotates; the tilt stays readable
        this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
        this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
        this.controls.minPolarAngle = 0.25;
        this.controls.maxPolarAngle = 1.3;
        // Shift + drag rotates: OrbitControls itself swaps pan and rotate while Shift (or Control, Meta) is held on the
        // press, wherever the focus is — nothing to listen for here
        this.controls.addEventListener('change', () => (this.dirty = true));
        this.controls.addEventListener('start', () => ((this.track = this.drift = null), this.dropComet(), this.handlers.cameraStart?.()));

        this.scene.add(new THREE.HemisphereLight(sceneColors(this.theme).sky, sceneColors(this.theme).ground, 1.2));
        const sun = new THREE.DirectionalLight('#ffffff', 0.9);
        sun.position.set(-90, 260, 140);
        this.scene.add(sun);
        this.pulses = [];
        this.pulseGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]);
        this.pulseDot = dotTexture();
        // soft glow on lines and lights; drawn only when a frame is drawn at all
        this.glow = true;
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.35, 0.62); // only bright cores and the selection glow
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());

        this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
        this.edgeGeo = new THREE.EdgesGeometry(this.boxGeo);
        this.group = new THREE.Group();
        this.scene.add(this.group);
        this.raycaster = new THREE.Raycaster();
        this.raycaster.params.Line.threshold = 0.9;
        this.pointer = new THREE.Vector2();
        this.rectTmp = { x0: 0, x1: 0, y0: 0, y1: 0, behind: false };
        this.projScreen = new THREE.Matrix4();
        this.toMeasure = []; // labels to measure this frame (size, measureQueued)
        this.frustum = new THREE.Frustum();
        this.stats = { nodes: 0, inView: 0, labels: 0, edges: 0 };
        this.frames = 0; // rendered frames (debug API: idle means it does not grow)

        this.warmUp();
        this.bindPointer();
        this.resizeWatch = new ResizeObserver(() => this.resize());
        this.resizeWatch.observe(container);
        // the stage's box on the page is read again after anything that may have moved it: a scroll of the page or of
        // the map's own narrow layout (inside the shadow root: not composed), a resize, and — as the page around an
        // embedded map may move it without either — each pointer event and each drawn frame (labelPass)
        const stale = () => (this.rect = null), quiet = { passive: true, capture: true, signal: this.signal };
        for (const t of ['scroll', 'resize']) window.addEventListener(t, stale, quiet);
        (env.root as unknown as EventTarget).addEventListener('scroll', stale, quiet);
        for (const t of ['pointerover', 'pointerdown', 'pointermove', 'wheel']) this.labels.domElement.addEventListener(t, stale, quiet);
        this.resize();
        this.loop = this.loop.bind(this);
        this.raf = requestAnimationFrame(this.loop);
    }

    /**
     * Frees everything the scene holds (destroy): the frame loop and its timers, the controls' listeners, every
     * geometry, material and texture, the composer's targets, the WebGL context, and its elements in the container.
     * The listeners it added outside them go with the map's signal. Twice is a no-op.
     */
    dispose(): void {
        if (this.dead) return;
        this.dead = true;
        cancelAnimationFrame(this.raf);
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
        this.resizeWatch.disconnect();
        this.controls.dispose();
        this.dropComet();
        this.clearPulses();
        const textures = new Set<THREE.Texture>([this.pulseDot, this.kit.dot]);
        if (this.scene.background instanceof THREE.Texture) textures.add(this.scene.background);
        disposeTree(this.scene, textures);
        disposeTree(this.warm, textures);
        for (const g of [this.boxGeo, this.edgeGeo, this.pulseGeo]) g.dispose();
        for (const t of textures) t.dispose();
        this.composer.dispose();
        this.bloom.dispose();
        this.renderer.renderLists.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        this.renderer.domElement.remove();
        this.labels.domElement.remove();
        this.nodes.clear();
        this.edges.clear();
        this.chips.clear();
    }

    /**
     * Shaders of every kind of visual are compiled once at start, off screen. Otherwise the first board with a dot grid
     * (or the first glyph of a kind) compiles its shader the moment it grows into view, and the GPU stops presenting
     * frames for ~¼ s in the middle of a level change. The materials are kept, so their programs stay cached.
     */
    warmUp(): void {
        const warm = new THREE.Group();
        const kid = { shape: 'core', type: 'module', children: [] };
        const base = { _size: { w: 12, h: 1, d: 10 }, type: 'module', layer: 'service', parent: 'x', children: [], endpoints: [{ method: 'GET' }] };
        const kinds = [
            ...['endpoints', 'core', 'stack', 'grid', 'orbit', 'frame', 'arrow', 'person', 'clock', 'ring', 'matrix'].map((shape) => ({ ...base, shape, children: shape === 'matrix' ? [kid, kid] : [] })),
            { ...base, shape: 'person', parent: null, type: 'actor' }, // a client-layer tile with its halo
            { ...base, shape: 'matrix', _plate: true, _size: { w: 30, h: 0.6, d: 20 }, children: [kid] },
            { ...base, shape: 'matrix', _plate: true, _column: true, type: 'system', _size: { w: 30, h: 40, d: 20 }, children: [kid] },
        ];
        for (const n of kinds) {
            const v = buildVisual(n as unknown as PlacedNode, this.kit); // a stand-in node: only what buildVisual reads
            v.detail.visible = true;
            warm.add(v.obj);
        }
        warm.add(new THREE.Points(this.pulseGeo, new THREE.PointsMaterial({ color: '#fff', size: 7, sizeAttenuation: false, map: this.pulseDot, transparent: true, depthWrite: false, toneMapped: false })));
        const geo = new LineGeometry();
        geo.setPositions([0, 0, 0, 1, 1, 1]);
        geo.setColors([1, 1, 1, 1, 1, 1]);
        warm.add(new Line2(geo, new LineMaterial({ vertexColors: true, linewidth: 2, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false })));
        this.warm = warm; // never disposed: a program is dropped when no material uses it
        try {
            ((this.renderer.compileAsync ?? this.renderer.compile) as (o: THREE.Object3D, c: THREE.Camera, s: THREE.Scene) => { catch?: (f: () => void) => unknown } | undefined).call(this.renderer, warm, this.camera, this.scene)?.catch?.(() => {});
        } catch {
            /* warm-up is an optimisation only */
        }
    }

    resize(): void {
        const { clientWidth: w, clientHeight: h } = this.container;
        this.renderer.setSize(w, h);
        this.composer?.setSize(w, h);
        this.lineRes = this.lineRes ?? new THREE.Vector2();
        this.lineRes.set(w, h);
        for (const v of this.edges?.values() ?? []) v.mat.resolution.copy(this.lineRes);
        this.labels.setSize(w, h);
        this.rect = null;
        this.camera.aspect = w / Math.max(1, h);
        this.camera.updateProjectionMatrix();
        this.dirty = true;
    }

    // ---------- layout: tweens, fades, node and plate views (scene-layout.ts) ----------
    setLayout(...a: Rest<typeof layout.setLayout>) { return layout.setLayout(this, ...a); }
    sameLayout(...a: Rest<typeof layout.sameLayout>) { return layout.sameLayout(this, ...a); }
    stepAnim(...a: Rest<typeof layout.stepAnim>) { return layout.stepAnim(this, ...a); }
    endTweens(...a: Rest<typeof layout.endTweens>) { return layout.endTweens(this, ...a); }
    finishMotion(...a: Rest<typeof layout.finishMotion>) { return layout.finishMotion(this, ...a); }
    placeLabel(...a: Rest<typeof layout.placeLabel>) { return layout.placeLabel(this, ...a); }
    fadeOut(...a: Rest<typeof layout.fadeOut>) { return layout.fadeOut(this, ...a); }
    fadeIn(...a: Rest<typeof layout.fadeIn>) { return layout.fadeIn(this, ...a); }
    endFade(...a: Rest<typeof layout.endFade>) { return layout.endFade(this, ...a); }
    stepFades(...a: Rest<typeof layout.stepFades>) { return layout.stepFades(this, ...a); }
    fadeOutEdges(...a: Rest<typeof layout.fadeOutEdges>) { return layout.fadeOutEdges(this, ...a); }
    stepOpacity(...a: Rest<typeof layout.stepOpacity>) { return layout.stepOpacity(this, ...a); }
    makeNode(...a: Rest<typeof layout.makeNode>) { return layout.makeNode(this, ...a); }
    updateNode(...a: Rest<typeof layout.updateNode>) { return layout.updateNode(this, ...a); }
    dropNode(...a: Rest<typeof layout.dropNode>) { return layout.dropNode(this, ...a); }
    makeLayerPlate(...a: Rest<typeof layout.makeLayerPlate>) { return layout.makeLayerPlate(this, ...a); }

    /** How long the change running now takes (a camera flight started with it takes the same). */
    get moveMs(): number {
        return this.anim?.dur || MOVE_MS;
    }

    // ---------- edges: relations, envelope chips, pulses (scene-edges.ts) ----------
    clearEdges(...a: Rest<typeof edges.clearEdges>) { return edges.clearEdges(this, ...a); }
    buildEdges(...a: Rest<typeof edges.buildEdges>) { return edges.buildEdges(this, ...a); }
    syncChips(...a: Rest<typeof edges.syncChips>) { return edges.syncChips(this, ...a); }
    clearPulses(...a: Rest<typeof edges.clearPulses>) { return edges.clearPulses(this, ...a); }
    makePulses(...a: Rest<typeof edges.makePulses>) { return edges.makePulses(this, ...a); }

    // ---------- view: focus, selection, what is shown ----------
    /**
     * view.keep   — ids drawn normally while a focus is on (others become ghosts), or null
     * view.edges  — folded edge ids that are drawn at all, or null for every edge
     * view.lit    — ids of the selected/hovered thing and its neighbours, or null
     * view.litEdges — edges of the selected/hovered thing
     */
    setView(view: SceneView): void {
        this.view = view;
        this.applyView();
    }

    applyView(...a: Rest<typeof style.applyView>) { return style.applyView(this, ...a); }

    // ---------- camera: flights, rides, drifts and shots (scene-camera.ts) ----------
    fitAll(...a: Rest<typeof camera.fitAll>) { return camera.fitAll(this, ...a); }
    fitDistance(...a: Rest<typeof camera.fitDistance>) { return camera.fitDistance(this, ...a); }
    fly(...a: Rest<typeof camera.fly>) { return camera.fly(this, ...a); }
    stepCam(...a: Rest<typeof camera.stepCam>) { return camera.stepCam(this, ...a); }
    boxOf(...a: Rest<typeof camera.boxOf>) { return camera.boxOf(this, ...a); }
    shotOf(...a: Rest<typeof camera.shotOf>) { return camera.shotOf(this, ...a); }
    frameIds(...a: Rest<typeof camera.frameIds>) { return camera.frameIds(this, ...a); }
    trackCurve(...a: Rest<typeof camera.trackCurve>) { return camera.trackCurve(this, ...a); }
    stepTrack(...a: Rest<typeof camera.stepTrack>) { return camera.stepTrack(this, ...a); }
    makeComet(...a: Rest<typeof camera.makeComet>) { return camera.makeComet(this, ...a); }
    dropComet(...a: Rest<typeof camera.dropComet>) { return camera.dropComet(this, ...a); }
    driftFor(...a: Rest<typeof camera.driftFor>) { return camera.driftFor(this, ...a); }
    stepDrift(...a: Rest<typeof camera.stepDrift>) { return camera.stepDrift(this, ...a); }
    stopShots(...a: Rest<typeof camera.stopShots>) { return camera.stopShots(this, ...a); }
    keepInFrame(...a: Rest<typeof camera.keepInFrame>) { return camera.keepInFrame(this, ...a); }
    tightDistance(...a: Rest<typeof camera.tightDistance>) { return camera.tightDistance(this, ...a); }
    fitIds(...a: Rest<typeof camera.fitIds>) { return camera.fitIds(this, ...a); }
    flyTo(...a: Rest<typeof camera.flyTo>) { return camera.flyTo(this, ...a); }
    preset(...a: Rest<typeof camera.preset>) { return camera.preset(this, ...a); }
    levelChanged(...a: Rest<typeof camera.levelChanged>) { return camera.levelChanged(this, ...a); }

    // ---------- pointer, screen geometry, preview (scene-pick.ts) ----------
    bindPointer(...a: Rest<typeof pick.bindPointer>) { return pick.bindPointer(this, ...a); }
    pickAt(...a: Rest<typeof pick.pickAt>) { return pick.pickAt(this, ...a); }
    rehover(...a: Rest<typeof pick.rehover>) { return pick.rehover(this, ...a); }
    ndcRect(...a: Rest<typeof pick.ndcRect>) { return pick.ndcRect(this, ...a); }
    screenArea(...a: Rest<typeof pick.screenArea>) { return pick.screenArea(this, ...a); }
    blocksInFrame(...a: Rest<typeof pick.blocksInFrame>) { return pick.blocksInFrame(this, ...a); }
    nodesAt(...a: Rest<typeof pick.nodesAt>) { return pick.nodesAt(this, ...a); }
    blockNear(...a: Rest<typeof pick.blockNear>) { return pick.blockNear(this, ...a); }
    screenCenter(...a: Rest<typeof pick.screenCenter>) { return pick.screenCenter(this, ...a); }
    screenRect(...a: Rest<typeof pick.screenRect>) { return pick.screenRect(this, ...a); }
    blockBoxes(...a: Rest<typeof pick.blockBoxes>) { return pick.blockBoxes(this, ...a); }
    blocksOnMap(...a: Rest<typeof pick.blocksOnMap>) { return pick.blocksOnMap(this, ...a); }
    labelRect(...a: Rest<typeof pick.labelRect>) { return pick.labelRect(this, ...a); }
    nameBoxes(...a: Rest<typeof pick.nameBoxes>) { return pick.nameBoxes(this, ...a); }
    steerZoom(...a: Rest<typeof pick.steerZoom>) { return pick.steerZoom(this, ...a); }
    zoomFloor(...a: Rest<typeof pick.zoomFloor>) { return pick.zoomFloor(this, ...a); }
    setPreview(...a: Rest<typeof pick.setPreview>) { return pick.setPreview(this, ...a); }
    completePreview(...a: Rest<typeof pick.completePreview>) { return pick.completePreview(this, ...a); }
    endPreview(...a: Rest<typeof pick.endPreview>) { return pick.endPreview(this, ...a); }
    stepPreview(...a: Rest<typeof pick.stepPreview>) { return pick.stepPreview(this, ...a); }
    screenWidth(...a: Rest<typeof pick.screenWidth>) { return pick.screenWidth(this, ...a); }
    hitLists(...a: Rest<typeof pick.hitLists>) { return pick.hitLists(this, ...a); }
    bodies(...a: Rest<typeof pick.bodies>) { return pick.bodies(this, ...a); }
    stageRect(...a: Rest<typeof pick.stageRect>) { return pick.stageRect(this, ...a); }
    aim(...a: Rest<typeof pick.aim>) { return pick.aim(this, ...a); }
    pick(...a: Rest<typeof pick.pick>) { return pick.pick(this, ...a); }

    // ---------- frame ----------
    loop(now: number): void {
        if (this.dead) return;
        this.raf = requestAnimationFrame(this.loop);
        const dt = Math.min(50, now - (this.lastNow ?? now)); // ms
        frame.askZoom(this, now);
        frame.stepMotion(this, now, dt);
        frame.fadeInEdges(this, now);
        if (this.controls.update()) this.dirty = true;
        this.stepOpacity(dt);
        frame.trackCameraVelocity(this, dt);
        frame.noticeRest(this, now);
        frame.movePulses(this, dt);
        this.lastNow = now;
        if (!this.dirty) return;
        this.dirty = false;
        frame.draw(this);
    }

    // ---------- labels: size, placement, level of detail (scene-labels.ts) ----------
    size(...a: Rest<typeof labels.size>) { return labels.size(this, ...a); }
    measureQueued(...a: Rest<typeof labels.measureQueued>) { return labels.measureQueued(this, ...a); }
    cullLabels(...a: Rest<typeof labels.cullLabels>) { return labels.cullLabels(this, ...a); }
    lineSegments(...a: Rest<typeof labels.lineSegments>) { return labels.lineSegments(this, ...a); }

}

