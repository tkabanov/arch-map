// Trackpad input rules (AD-15). input.ts is pure; the browser checks (CDP pinch replay, mouse-wheel notches,
// two-finger pan, offline, fps) are described in docs/browser-checks.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pinchLimiter, wheelClassifier, gesturePinch, NOTCH, PINCH_WINDOW, PAN_LATCH, GESTURE_GAP, GESTURE_DELTA } from '../viewer/src/input.ts';

test('pinch: one event never exceeds one notch, either way', () => {
    const limit = pinchLimiter();
    assert.equal(limit(-450, 0), -NOTCH);
    assert.equal(limit(380, 1000), NOTCH);
    assert.equal(limit(-30, 2000), -30);
});

test('pinch: a whole window never exceeds one notch', () => {
    const limit = pinchLimiter();
    let sum = 0;
    for (let t = 0; t < PINCH_WINDOW; t += 16) sum += Math.abs(limit(-60, t)); // 60 Hz, boosted pinch deltas
    assert.equal(sum, NOTCH);
    assert.equal(limit(-60, PINCH_WINDOW + 1), -60); // the next window starts fresh
});

test('pinch: a long pinch zooms no faster than one notch per window', () => {
    const limit = pinchLimiter();
    let sum = 0;
    for (let t = 0; t < 1000; t += 16) sum += Math.abs(limit(-80, t));
    assert.ok(sum <= NOTCH * Math.ceil(1000 / PINCH_WINDOW), `sum ${sum}`);
});

test('classifier: pinch, Ctrl + wheel, mouse notch', () => {
    const c: (e: { ctrlKey: boolean; deltaX: number; deltaY: number }, now: number, controlHeld?: boolean) => string = wheelClassifier(); // a wheel event: deltaY is not read
    assert.equal(c({ ctrlKey: true, deltaX: 0, deltaY: -3 }, 0), 'pinch');
    assert.equal(c({ ctrlKey: true, deltaX: 0, deltaY: -100 }, 10, true), 'zoom'); // Control really held: no pinch rules
    assert.equal(c({ ctrlKey: false, deltaX: 0, deltaY: 100 }, 20), 'zoom');
    assert.equal(c({ ctrlKey: false, deltaX: 0, deltaY: -100 }, 30), 'zoom');
});

test('classifier: two-finger scroll with a horizontal part pans, and its vertical tail too', () => {
    const c: (e: { ctrlKey: boolean; deltaX: number; deltaY: number }, now: number, controlHeld?: boolean) => string = wheelClassifier(); // a wheel event: deltaY is not read
    assert.equal(c({ ctrlKey: false, deltaX: 30, deltaY: 0 }, 0), 'pan');
    assert.equal(c({ ctrlKey: false, deltaX: 0, deltaY: 12 }, 50), 'pan'); // same gesture
    assert.equal(c({ ctrlKey: false, deltaX: 0, deltaY: 100 }, 50 + PAN_LATCH + 1), 'zoom'); // a later mouse notch zooms
    assert.equal(c({ ctrlKey: true, deltaX: 4, deltaY: -3 }, 60), 'pinch'); // a pinch is never a pan
});

test('the scene (scene.ts and its scene-*.ts modules) uses MapControls over the limiter, and the classifier runs before the controls', () => {
    const dir = new URL('../viewer/src/', import.meta.url);
    const src = readdirSync(dir).filter((f) => /^scene(-[a-z]+)?\.ts$/.test(f)).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
    assert.match(src, /class MapControls extends OrbitControls/);
    assert.match(src, /new MapControls\(/);
    assert.doesNotMatch(src, /new OrbitControls\(/);
    assert.match(src, /capture: true/);
    assert.match(src, /zoomSpeed = 2\.4/);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.devDependencies.three, '0.186.1'); // the override depends on this pin
});

test('pinch: after a level change the rest of the gesture is ignored, the next gesture zooms again', () => {
    const limit = pinchLimiter();
    assert.equal(limit(-40, 0), -40);
    limit.hold();
    assert.equal(limit(-40, 32), 0);
    assert.equal(limit(-40, 32 + GESTURE_GAP - 1), 0); // still the same gesture (gap below GESTURE_GAP)
    assert.equal(limit(-40, 32 + 3 * GESTURE_GAP), -40); // a new gesture
    const late = pinchLimiter();
    late(-40, 0);
    late.hold(); // the gesture already ended: its successor starts fresh
    assert.equal(late(-40, GESTURE_GAP + 150), -40);
});

test('pinch: a held gesture is reported as held until it ends', () => {
    const limit = pinchLimiter();
    limit(-40, 0);
    assert.equal(limit.held(10), false);
    limit.hold();
    assert.equal(limit.held(20), true);
    limit(-40, 20);
    assert.equal(limit.held(20 + GESTURE_GAP + 1), false);
});

test('pinch: a held gesture stays held while its events keep coming, however long it runs (scene-pick stops them before limit)', () => {
    const limit = pinchLimiter();
    limit(-40, 0);
    limit.hold();
    // 60 Hz events for a second, each only asked `held` (the way the map's wheel listener does)
    for (let t = 16; t <= 1000; t += 16) assert.equal(limit.held(t), true, `t=${t}`);
    assert.equal(limit.held(1000 + GESTURE_GAP + 1), false); // the gesture ended
    assert.equal(limit(-40, 1000 + GESTURE_GAP + 2), -40); // the next one zooms
});

test('Safari pinch: each gesturechange step is the ln of its scale ratio, spreading zooms in', () => {
    const g = gesturePinch();
    g.start();
    const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
    near(g.change(1.05, 0), -GESTURE_DELTA * Math.log(1.05)); // in: negative deltaY, like a wheel up
    near(g.change(1.10, 16), -GESTURE_DELTA * Math.log(1.10 / 1.05)); // relative to the previous step, not to 1
    near(g.change(1.0, 32), -GESTURE_DELTA * Math.log(1.0 / 1.10)); // back: out, positive
    assert.ok(g.change(0.9, 48) > 0);
    assert.equal(g.change(0.9, 64), 0); // no change, no zoom
});

test('Safari pinch: the steps of one gesture add up to ln of its final scale; a new gesture starts from 1', () => {
    const g = gesturePinch();
    g.start();
    let sum = 0;
    for (const s of [1.02, 1.07, 1.15, 1.3, 1.5]) sum += g.change(s, 0);
    assert.ok(Math.abs(sum + GESTURE_DELTA * Math.log(1.5)) < 1e-9);
    g.start();
    assert.ok(Math.abs(g.change(0.8, 1000) + GESTURE_DELTA * Math.log(0.8)) < 1e-9);
});

test('Safari pinch: bad scales never zoom', () => {
    const g = gesturePinch();
    g.start();
    for (const s of [0, -1, NaN, Infinity]) assert.equal(g.change(s, 0), 0);
    assert.ok(g.change(1.1, 16) < 0); // and do not break the next step
});

test('Safari pinch: no double zoom when the browser also sends the pinch as ctrlKey wheel', () => {
    const g = gesturePinch();
    g.start();
    g.nativeWheel(100);
    assert.equal(g.change(1.2, 100 + GESTURE_GAP), 0);
    assert.ok(g.change(1.4, 101 + GESTURE_GAP * 2) < 0); // the native wheel stopped: the gesture zooms again
});

test('Safari pinch: a typical gesture fed through the limiter moves like a Chrome pinch (≤ one notch per window)', () => {
    const g = gesturePinch();
    const limit = pinchLimiter();
    g.start();
    let used = 0;
    for (let k = 1; k <= 6; k++) used += Math.abs(limit(10 * g.change(1 + 0.04 * k, k * 16), k * 16)); // ×10: the controls' pinch boost
    assert.ok(used > 0 && used <= NOTCH);
});
