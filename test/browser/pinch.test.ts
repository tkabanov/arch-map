// The seeded pinch replay: trackpad pinch arrives as ctrlKey wheel events. CDP Input.dispatchMouseEvent
// mouseWheel with modifiers: 2 (ctrlKey, no Control keydown), 20 seeded series of 25–60 events at 60 Hz with a
// bell-shaped deltaY — 6 in, then 14 out — on library-nest, down to loan_module and back. Spec: every series
// moves at most one level (no skips). The pinch limit lives in MapControls internals of three 0.186.1: re-run this
// after any three bump (docs/browser-checks.md, "The three-bump rule").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, aim, VIEWPORT, focusOf, recordFocus, focusSeen, measure, sleep, DOCS } from './lib.ts';

const TARGET = 'library.api.loans.loan_module';

interface Series { s: number; dir: 'in' | 'out'; events: number; peak: number; from: string | null; to: string | null; seen: (string | null)[]; levels: number }

/** Run the 20 series (same seed as the fixed seed 12345, so the series are the same every run). */
async function replay(page: Page): Promise<Series[]> {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const cdp = await page.context().newCDPSession(page);
    await recordFocus(page);
    const out: Series[] = [];
    for (let s = 0; s < 20; s++) {
        const dir = s < 6 ? -1 : 1;
        const a = (await aim(page, TARGET)) ?? { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
        const from = await focusOf(page);
        await recordFocus(page);
        const n = 25 + Math.floor(rnd() * 36), peak = (dir < 0 ? 3 : 6) + Math.floor(rnd() * 10);
        const t0 = Date.now();
        for (let k = 0; k < n; k++) {
            const deltaY = dir * Math.max(1, Math.round(peak * Math.sin((Math.PI * (k + 0.5)) / n)));
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: a.x, y: a.y, deltaX: 0, deltaY, modifiers: 2 });
            const wait = t0 + (k + 1) * (1000 / 60) - Date.now();
            if (wait > 0) await sleep(wait);
        }
        await sleep(1700);
        const seen = await focusSeen(page);
        out.push({ s, dir: dir < 0 ? 'in' : 'out', events: n, peak, from, to: await focusOf(page), seen, levels: seen.length - 1 });
    }
    await cdp.detach();
    return out;
}

let browser: Browser;
let series: Series[] = [];
let errors: string[] = [];
before(async () => {
    browser = await launch();
    const o = await open(browser, DOCS.library, 3000);
    errors = o.errors;
    series = await replay(o.page);
    await o.page.close();
});
after(async () => { await browser?.close(); });

const short = (x: Series) => `${x.dir[0]}${x.levels}`;

test('pinch: the replay reaches the loan module and comes back to the resting view, 0 console errors', (t) => {
    measure(t, {
        seq: series.map(short).join(' '),
        levelChanges: series.filter((x) => x.from !== x.to).length,
        maxStep: Math.max(...series.map((x) => x.levels)),
        skips: series.filter((x) => x.levels > 1).length,
        series: series.map(({ s, dir, events, peak, seen }) => ({ s, dir, events, peak, seen })),
    });
    assert.ok(series.some((x) => x.to === TARGET), 'loan module never reached');
    assert.equal(series[series.length - 1].to, null, 'not back at the resting view');
    assert.deepEqual(errors, []);
});

test('pinch in: every series moves at most one level', () => {
    const bad = series.filter((x) => x.dir === 'in' && x.levels > 1);
    assert.deepEqual(bad.map((x) => ({ s: x.s, seen: x.seen })), []);
});

test('pinch out: every series moves at most one level', () => {
    const bad = series.filter((x) => x.dir === 'out' && x.levels > 1);
    assert.deepEqual(bad.map((x) => ({ s: x.s, seen: x.seen })), []);
});
