// The wheel and trackpad: OrbitControls with a pinch limiter and a queued, softened wheel zoom (AD-15).
// The class and its module augmentation are kept exactly as they were in scene.ts when it was split (imports and `export` aside).
// Depends on three 0.186.1 internals (`_customWheelEvent`, `_controlActive`, …) — re-run the pinch browser check (docs/browser-checks.md) on a three bump.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { pinchLimiter } from './input.ts';
import type { PinchLimiter } from './input.ts';
import type { ScreenPoint } from '../../types/scene.ts';

// OrbitControls internals that MapControls overrides or reads (three 0.186.1; @types/three does not declare them)
declare module 'three/examples/jsm/controls/OrbitControls.js' {
    interface OrbitControls {
        _controlActive: boolean;
        _scale: number;
        _sphericalDelta: THREE.Spherical;
        _panOffset: THREE.Vector3;
        _customWheelEvent(event: WheelEvent): { clientX: number; clientY: number; deltaY: number };
        _handleMouseWheel(event: { clientX: number; clientY: number; deltaY: number }): void;
        _getZoomScale(delta: number): number;
        _updateZoomParameters(x: number, y: number): void;
    }
}

/**
 * OrbitControls with a trackpad pinch that zooms like the mouse wheel (AD-15). The parent boosts a pinch
 * (`ctrlKey` wheel without a Control keydown) ×10; here the boosted delta is limited to one notch per event and per
 * 100 ms, so the autofocus thresholds tuned on the mouse hold for the pinch; after a level change the rest of the
 * gesture is ignored (`levelChanged`). Every other wheel event is untouched.
 * Depends on the three 0.186.1 internals `_customWheelEvent` and `_controlActive`: re-run the pinch browser check (docs/browser-checks.md) on a bump.
 */
export class MapControls extends OrbitControls {
    declare limitPinch: PinchLimiter;
    declare zoomLeft: number;
    declare zoomMid: number;
    declare zoomAt: ScreenPoint;
    /** The bottom of the map under the cursor (zoomFloor): the wheel does not zoom in there. */
    declare floor?: ScreenPoint | null;
    /** Where the wheel zooms while the cursor points at nothing (steerZoom). */
    declare steer?: ScreenPoint | null;
    constructor(camera: THREE.PerspectiveCamera, el: HTMLElement, signal: AbortSignal) {
        super(camera, el);
        // the parent hears Control on `el.getRootNode()`: in a shadow root only while the focus is inside the map, so a
        // Control held elsewhere made a mouse's Ctrl + wheel a pinch. The window hears every key (composed events).
        const control = (on: boolean) => (e: KeyboardEvent) => e.key === 'Control' && (this._controlActive = on);
        const opts = { capture: true, passive: true, signal };
        window.addEventListener('keydown', control(true), opts);
        window.addEventListener('keyup', control(false), opts);
        window.addEventListener('blur', () => (this._controlActive = false), opts);
        this.limitPinch = pinchLimiter();
        // wheel zoom still to apply, as the log of the scale, in two smoothing stages (stepZoom)
        this.zoomLeft = 0;
        this.zoomMid = 0;
        this.zoomAt = { x: 0, y: 0 };
    }
    _customWheelEvent(event: WheelEvent) {
        const e = super._customWheelEvent(event);
        if (event.ctrlKey && !this._controlActive) e.deltaY = this.limitPinch(e.deltaY, event.timeStamp);
        return e;
    }
    /**
     * A wheel notch is not done in one frame (that made everything far from the cursor jump): it is queued and
     * `stepZoom` lets it in over ~¼ s, starting and ending softly. The total per notch is the same, so the notch counts
     * the autofocus was tuned with hold.
     */
    _handleMouseWheel(event: { clientX: number; clientY: number; deltaY: number }) {
        if (!event.deltaY) return;
        if (event.deltaY > 0) this.floor = null;
        else if (this.floor) return; // at the bottom: nothing more to zoom into here
        const s = Math.log(this._getZoomScale(event.deltaY));
        this.zoomLeft += event.deltaY < 0 ? s : -s;
        // toward the cursor, or toward the block the app steers it to while the cursor points at nothing
        this.zoomAt = (event.deltaY < 0 && this.steer) || { x: event.clientX, y: event.clientY };
    }
    /** This frame's share of the queued zoom (`dt` in ms), toward the cursor; true while some is left. */
    stepZoom(dt: number): boolean {
        if (!this.zoomLeft && !this.zoomMid) return false;
        const a = 1 - Math.exp(-dt / ZOOM_TAU);
        const d1 = this.zoomLeft * a;
        this.zoomLeft -= d1;
        this.zoomMid += d1;
        let d2 = this.zoomMid * a;
        this.zoomMid -= d2;
        if (Math.abs(this.zoomLeft) + Math.abs(this.zoomMid) < 2e-4) {
            d2 += this.zoomLeft + this.zoomMid;
            this.zoomLeft = this.zoomMid = 0;
        }
        this._updateZoomParameters(this.zoomAt.x, this.zoomAt.y);
        this._scale *= Math.exp(d2);
        return true;
    }
    /** A flight takes the camera: the zoom still queued and the damped drag and turn would fight it. */
    hold() {
        this.zoomLeft = this.zoomMid = 0;
        this.steer = this.floor = null;
        this._sphericalDelta.set(0, 0, 0);
        this._panOffset.set(0, 0, 0);
    }
}
const ZOOM_TAU = 55; // ms, each of the two stages: a notch is ~95% in after ~260 ms, the mouse's pace between notches
