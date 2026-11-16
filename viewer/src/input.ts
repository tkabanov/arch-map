// Wheel input rules (AD-15), kept free of three.js and the DOM so they can be tested in node.
//
// Chrome on macOS sends a trackpad pinch as `wheel` events with `ctrlKey: true` and no Control keydown; OrbitControls
// multiplies their deltaY by 10. A two-finger scroll is a plain wheel event, usually with a horizontal part. A mouse
// notch is a plain wheel event with deltaY ±100 (pixel mode) and no horizontal part.

/** One mouse-wheel notch in pixel deltaY: the unit the autofocus thresholds were tuned with. */
export const NOTCH = 100;
/** A pinch may zoom at most one notch per this many milliseconds. */
export const PINCH_WINDOW = 100;
/** After a wheel event with a horizontal part, plain wheel events pan (not zoom) for this long. */
export const PAN_LATCH = 200;

/** Pinch events further apart than this belong to different gestures. */
export const GESTURE_GAP = 250;

/** The limiter: call it per pinch event; `hold` and `held` as below. */
export interface PinchLimiter {
    (delta: number, now: number): number;
    hold: () => boolean;
    held: (now: number) => boolean;
}

/**
 * Pinch limiter: `limit(delta, t)` returns the delta to apply; `t` is the event's `timeStamp` (input time, so a busy
 * main thread does not split one gesture in two). One event never exceeds one notch, and all events in
 * one `PINCH_WINDOW` together never exceed one notch, so a pinch zooms no faster than a quick mouse wheel.
 * `limit.hold()`: the focus level just changed — the rest of the current gesture zooms no more, so one pinch moves
 * at most one level. A gesture ends after `GESTURE_GAP` without pinch events; the next one starts fresh.
 */
export function pinchLimiter(): PinchLimiter {
    let t0 = -Infinity;
    let used = 0;
    let last = -Infinity;
    let held = false;
    const limit = ((delta: number, now: number): number => {
        if (now - last > GESTURE_GAP) held = false;
        last = now;
        if (held) return 0;
        if (now - t0 >= PINCH_WINDOW) {
            t0 = now;
            used = 0;
        }
        const d = Math.min(Math.abs(delta), NOTCH, NOTCH - used);
        used += d;
        return d ? Math.sign(delta) * d : 0;
    }) as PinchLimiter;
    // a gesture that already ended is released by its successor's first event (gap > GESTURE_GAP)
    limit.hold = () => (held = true);
    /**
     * Whether an event at `now` belongs to a held gesture (it neither zooms nor counts as zooming). A held event never
     * reaches `limit`, so it keeps the gesture alive here: otherwise a pinch still going GESTURE_GAP after the level
     * changed counted as a new gesture and zoomed on into the next level (two levels per pinch).
     */
    limit.held = (now: number) => {
        if (!held || now - last > GESTURE_GAP) return false;
        last = Math.max(last, now);
        return true;
    };
    return limit;
}

export type WheelClass = 'pinch' | 'pan' | 'zoom';

/**
 * Wheel classifier: `classify(e, now, controlHeld)` → 'pinch' | 'pan' | 'zoom'.
 * - `ctrlKey` without a held Control key = pinch (zooms, limited);
 * - no `ctrlKey` and a horizontal part, or within `PAN_LATCH` of one = two-finger pan (no zoom);
 * - everything else = zoom (the mouse wheel; a purely vertical two-finger scroll cannot be told apart and zooms too).
 */
export function wheelClassifier(): (e: { ctrlKey: boolean; deltaX: number }, now: number, controlHeld?: boolean) => WheelClass {
    let panUntil = -Infinity;
    return (e, now, controlHeld = false) => {
        if (e.ctrlKey) return controlHeld ? 'zoom' : 'pinch';
        if (e.deltaX !== 0) panUntil = now + PAN_LATCH;
        return now < panUntil ? 'pan' : 'zoom';
    };
}

/** Pinch deltaY per unit of ln(scale): Chrome's ctrlKey wheel for the same pinch, so both zoom alike. */
export const GESTURE_DELTA = 100;

/** The pinch converter for Safari: `start()` at gesturestart, `change(scale, t)` per gesturechange, `nativeWheel(t)` per trusted ctrlKey wheel. */
export interface GesturePinch {
    start: () => void;
    change: (scale: number, now: number) => number;
    nativeWheel: (now: number) => void;
}

/**
 * Safari on macOS sends a trackpad pinch as WebKit `gesturestart` / `gesturechange` / `gestureend` with `scale`, the
 * scale since the gesture began, and no ctrlKey wheel. `change(scale, t)` returns the ctrlKey wheel deltaY of that step:
 * `-GESTURE_DELTA · ln(scale / previous scale)` (spreading the fingers zooms in, as a negative deltaY does), which then
 * takes the pinch's own path (the ×10 boost, `pinchLimiter`, one level per gesture). A browser that sends the pinch as
 * ctrlKey wheel events too is not zoomed twice: within `GESTURE_GAP` of a trusted ctrlKey wheel a step returns 0.
 */
export function gesturePinch(): GesturePinch {
    let prev = 1;
    let native = -Infinity;
    return {
        start: () => (prev = 1),
        change: (scale, now) => {
            if (!(scale > 0) || !Number.isFinite(scale)) return 0;
            const r = scale / prev;
            prev = scale;
            if (now - native <= GESTURE_GAP) return 0;
            const d = -GESTURE_DELTA * Math.log(r);
            return Object.is(d, -0) ? 0 : d;
        },
        nativeWheel: (now) => (native = now),
    };
}
