// Safari's trackpad pinch: WebKit sends `gesturestart` / `gesturechange` / `gestureend` with a cumulative `scale` and
// no ctrlKey wheel (input.ts gesturePinch). Playwright has no way to make a real WebKit gesture, so the events are
// built here as WebKit builds them (scale since gesturestart, clientX/clientY at the fingers) and dispatched at the
// element under the point, at 60 Hz: 6 series in, then out, on library-nest down to loan_module and back.
// Spec: the pinch zooms the map, every series moves at most one level, the page itself never zooms.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, aim, VIEWPORT, focusOf, recordFocus, focusSeen, measure, sleep, DOCS } from './lib.ts';

const TARGET = 'library.api.loans.loan_module';

interface Series { s: number; dir: 'in' | 'out'; events: number; scale: number; from: string | null; to: string | null; seen: (string | null)[]; levels: number }

/** One gesture at (x, y): `n` gesturechange events at 60 Hz, scale easing from 1 to `end`. */
async function gesture(page: Page, x: number, y: number, n: number, end: number): Promise<void> {
    const send = (type: string, scale: number) => page.evaluate((a) => {
        const root = (globalThis as unknown as { mapRoot: () => Document | ShadowRoot }).mapRoot();
        const target = root.elementFromPoint(a.x, a.y) ?? document.body;
        const e = new Event(a.type, { bubbles: true, cancelable: true, composed: true });
        for (const [k, v] of Object.entries({ scale: a.scale, rotation: 0, clientX: a.x, clientY: a.y })) Object.defineProperty(e, k, { value: v });
        target.dispatchEvent(e);
    }, { type, scale, x, y });
    await send('gesturestart', 1);
    const t0 = Date.now();
    for (let k = 1; k <= n; k++) {
        const f = (1 - Math.cos((Math.PI * k) / n)) / 2; // eased: slow, fast, slow, like fingers
        await send('gesturechange', 1 + (end - 1) * f);
        const wait = t0 + k * (1000 / 60) - Date.now();
        if (wait > 0) await sleep(wait);
    }
    await send('gestureend', end);
}

async function replay(page: Page): Promise<Series[]> {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const out: Series[] = [];
    for (let s = 0; s < 20; s++) {
        const dir = s < 6 ? 'in' : 'out';
        const a = (await aim(page, TARGET)) ?? { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
        const from = await focusOf(page);
        await recordFocus(page);
        const n = 25 + Math.floor(rnd() * 36);
        const scale = dir === 'in' ? 1.6 + rnd() * 1.4 : 1 / (1.6 + rnd() * 1.4);
        await gesture(page, a.x, a.y, n, scale);
        await sleep(1700);
        const seen = await focusSeen(page);
        out.push({ s, dir, events: n, scale: +scale.toFixed(3), from, to: await focusOf(page), seen, levels: seen.length - 1 });
    }
    return out;
}

let browser: Browser;
let series: Series[] = [];
let errors: string[] = [];
let pageScale = 1;
before(async () => {
    browser = await launch();
    const o = await open(browser, DOCS.library, 3000);
    errors = o.errors;
    series = await replay(o.page);
    pageScale = await o.page.evaluate(() => visualViewport?.scale ?? 1);
    await o.page.close();
});
after(async () => { await browser?.close(); });

test('Safari pinch: gesture events zoom the map to the loan module and back, 0 console errors', (t) => {
    measure(t, {
        seq: series.map((x) => `${x.dir[0]}${x.levels}`).join(' '),
        levelChanges: series.filter((x) => x.from !== x.to).length,
        series: series.map(({ s, dir, events, scale, seen }) => ({ s, dir, events, scale, seen })),
    });
    assert.ok(series.some((x) => x.to === TARGET), 'loan module never reached');
    assert.equal(series[series.length - 1].to, null, 'not back at the resting view');
    assert.deepEqual(errors, []);
    assert.equal(pageScale, 1);
});

test('Safari pinch: every series moves at most one level', () => {
    const bad = series.filter((x) => x.levels > 1);
    assert.deepEqual(bad.map((x) => ({ s: x.s, dir: x.dir, seen: x.seen })), []);
});
