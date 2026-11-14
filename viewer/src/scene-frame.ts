// The steps of one animation frame (`MapScene.loop` in scene.ts calls them in this order): the semantic-zoom question to
// the app, the running motions, the fade-in of rebuilt relations, the camera's velocity, the pulses, the drawing.
import * as THREE from 'three';
import { ease, EDGE_FADE_MS } from './scene-util.ts';
import type { MapScene } from './scene.ts';

/** Semantic zoom: while the wheel moves the camera, let the app decide every ~100 ms. First in the frame, so a level change made now is drawn from its own first frame (nothing new shows at full size for a frame). */
export function askZoom(scene: MapScene, now: number): void {
    if (scene.lastWheel && now - scene.lastWheel.t < 650 && now - (scene.zoomEval ?? 0) > 100 && !scene.anim && !scene.cam) {
        scene.zoomEval = now;
        scene.handlers.zoom?.(scene.lastWheel);
    }
    if (scene.controls.steer && !(scene.lastWheel && now - scene.lastWheel.t < 650)) scene.controls.steer = null; // the wheel stopped
}

/** The motions that run: the preview ring, the queued wheel zoom, a layout change, a camera flight (or ride, or drift), the fades. */
export function stepMotion(scene: MapScene, now: number, dt: number): void {
    scene.stepPreview(now, dt / 1000);
    if (!scene.cam && scene.controls.stepZoom(dt)) scene.dirty = true;
    if (scene.anim) scene.stepAnim(now);
    if (scene.cam) scene.stepCam(now);
    else if (scene.track) scene.stepTrack(now);
    else if (scene.drift) scene.stepDrift(now);
    scene.stepFades(now);
}

/** Relations rebuilt by a layout change come in over EDGE_FADE_MS. */
export function fadeInEdges(scene: MapScene, now: number): void {
    if (scene.edgeFade === null || scene.edgeFade === undefined) return;
    const k = ease(Math.min(1, (now - scene.edgeFade) / EDGE_FADE_MS));
    for (const v of scene.edges.values()) {
        if (!v.fresh) continue;
        v.mat.opacity = (v.op ?? v.mat.opacity) * k;
        v.label.element.style.filter = k < 1 ? `opacity(${k.toFixed(3)})` : ''; // filter, not opacity: keeps the .dim class
    }
    scene.dirty = true;
    if (k >= 1) scene.edgeFade = null;
}

/** How the camera moves now: a flight that starts goes on with it. */
export function trackCameraVelocity(scene: MapScene, dt: number): void {
    if (scene.lastCam && dt > 0) {
        scene.camVel.c.subVectors(scene.camera.position, scene.lastCam.c).divideScalar(dt);
        scene.camVel.t.subVectors(scene.controls.target, scene.lastCam.t).divideScalar(dt);
    }
    scene.lastCam ??= { c: new THREE.Vector3(), t: new THREE.Vector3() };
    scene.lastCam.c.copy(scene.camera.position);
    scene.lastCam.t.copy(scene.controls.target);
}

/** Below this speed (world units per ms, camera and target) the camera is still: a few px a second on screen. */
const STILL_SPEED = 0.001;
/** Still this long after moving: at rest. */
export const REST_MS = 120;

/**
 * The camera (or the layout) came to rest after moving: look again at what is under a still pointer. A wheel zoom or a
 * flight moves another block under it and no pointer event says so — the hover stayed on the old block until the
 * pointer moved. Once per rest, not while the map moves (a hover card would flicker over a moving map), never during
 * a drag (the buttons are held).
 */
export function noticeRest(scene: MapScene, now: number): void {
    const v2 = STILL_SPEED * STILL_SPEED;
    if (scene.cam || scene.track || scene.anim || scene.camVel.c.lengthSq() > v2 || scene.camVel.t.lengthSq() > v2) {
        scene.moved = true;
        scene.stillSince = null;
        return;
    }
    if (!scene.moved) return;
    scene.stillSince ??= now;
    if (now - scene.stillSince < REST_MS) return;
    scene.moved = false;
    scene.stillSince = null;
    if (!scene.pointerButtons) scene.rehover();
}

/** The pulses run along their relations. */
export function movePulses(scene: MapScene, dt: number): void {
    if (!scene.pulses.length) return;
    for (const p of scene.pulses) {
        p.t = (p.t + (dt / 1000) * p.speed) % 1;
        p.mesh.position.copy(p.curve.getPointAt(p.t));
    }
    scene.dirty = true;
}

/** Labels placed, the scene drawn (with the glow or without), the names over it. */
export function draw(scene: MapScene): void {
    scene.cullLabels();
    scene.frames++;
    if (scene.glow) scene.composer.render();
    else scene.renderer.render(scene.scene, scene.camera);
    scene.labels.render(scene.scene, scene.camera);
}
