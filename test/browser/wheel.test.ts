// Mouse wheel and two-finger pan with real input (page.mouse.wheel): notches per level in and out, on the three
// stacks. One notch = wheel(0, ∓100) every 260 ms, aimed at the target's deepest placed ancestor (lib.ts).
// The bands are the observed range over several runs plus a little margin (docs/browser-checks.md):
// the inner levels jitter by a notch between identical runs, the first level does not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import { launch, open, notchesIn, notchesOut, aim, focusOf, distance, within, measure, sleep, focus, DOCS, NOTCH_MS, VIEWPORT } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

/** [name, docs query, target id, notch band [lo, hi] from the resting view] — measured 2026-11-07, docs/browser-checks.md */
const IN: [string, string, string, number, number][] = [
    ['tasks-supabase → Backend', DOCS.tasks, 'tasks.system.platform', 3, 5],
    ['tasks-supabase → Edge Functions', DOCS.tasks, 'tasks.edge', 15, 18],
    ['tasks-supabase → Postgres', DOCS.tasks, 'tasks.db', 14, 17],
    ['tasks-supabase → task tables', DOCS.tasks, 'tasks.db.task', 21, 24],
    ['tasks-supabase → Workspace client', DOCS.tasks, 'tasks.system.client', 2, 4],
    ['library-nest → Backend', DOCS.library, 'library.api', 3, 5],
    ['library-nest → loan module', DOCS.library, 'library.api.loans.loan_module', 17, 20],
];

/** Notches per level change, from the `levels` list of notchesIn / notchesOut. */
const perLevel = (levels: [number, string | null][]) => levels.map(([n], i) => n - (i ? levels[i - 1][0] : 0));

for (const [name, qs, target, lo, hi] of IN) {
    test(`wheel in: ${name}`, async (t) => {
        const { page, errors } = await open(browser, qs);
        try {
            const r = await notchesIn(page, target);
            measure(t, { target, notches: r.notches, perLevel: perLevel(r.levels), levels: r.levels });
            assert.ok(r.reached, `${target} not reached: focus ${r.focus} after ${r.notches} notches`);
            within(r.notches, lo, hi, `notches to ${target}`, r.levels);
            assert.deepEqual(errors, []);
        } finally {
            await page.close();
        }
    });
}

/**
 * [name, docs query, deepest target, total notch band out to the resting view]. Every level out takes about as many
 * notches as the way in (~5); before 125ee20 the levels after the first cascaded in 1–3 notches. OUT_MIN guards that.
 */
const OUT: [string, string, string, number, number][] = [
    ['tasks-supabase: task tables → resting view', DOCS.tasks, 'tasks.db.task', 15, 17],
    ['library-nest: loan module → resting view', DOCS.library, 'library.api.loans.loan_module', 14, 17],
];

/** The fewest notches any one level out may take (measured 5–6). */
const OUT_MIN = 4;

/**
 * Where the overview lands, as a share of the resting view's camera distance. Before the zoom-out review (2026-11-08)
 * each level's way out began ~1.8× farther than the last, and a deep level left the overview at 1.8–3.8× the resting
 * distance (the map a speck); now the overview lands on the resting view (measured 0.98–1.0).
 */
const HOME_BAND: [number, number] = [0.9, 1.1];

for (const [name, qs, target, lo, hi] of OUT) {
    test(`wheel out: ${name}`, async (t) => {
        const { page, errors } = await open(browser, qs);
        try {
            const rest = await distance(page);
            const i = await notchesIn(page, target);
            assert.ok(i.reached, `${target} not reached on the way in`);
            const r = await notchesOut(page, null);
            const home = (await distance(page)) / rest;
            measure(t, { from: target, notches: r.notches, perLevel: perLevel(r.levels), levels: r.levels, home: +home.toFixed(3) });
            assert.ok(r.reached, `resting view not reached: focus ${r.focus} after ${r.notches} notches`);
            within(r.notches, lo, hi, `notches out from ${target}`, r.levels);
            within(Math.min(...perLevel(r.levels)), OUT_MIN, Infinity, `fewest notches for one level out from ${target} (a cascade?)`, r.levels);
            within(home, ...HOME_BAND, `overview distance / resting distance from ${target}`);
            assert.deepEqual(errors, []);
        } finally {
            await page.close();
        }
    });
}

/**
 * Out from a level entered by a search or a link (the focus framed with its neighbours, so it starts small): the
 * camera never sits at its farthest while levels close (a parent that is a speck is framed going up), and the overview
 * lands on the resting view. Before the review: 9 of 14 notches at the farthest distance, the map a speck.
 */
test('wheel out after a search: never stuck at the farthest distance, lands on the resting view', async (t) => {
    const { page, errors } = await open(browser, DOCS.library);
    try {
        const rest = await distance(page);
        const max = await page.evaluate(() => (window.archMap.scene.controls as unknown as { maxDistance: number }).maxDistance);
        await focus(page, 'library.api.loans.loan_module');
        await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
        let atMax = 0, n = 0;
        for (; n < 40 && (await focusOf(page)) !== null; n++) {
            await page.mouse.wheel(0, 100);
            await sleep(NOTCH_MS);
            if ((await distance(page)) >= max * 0.99) atMax++;
        }
        await sleep(1200);
        const home = (await distance(page)) / rest;
        measure(t, { notches: n, atMax, home: +home.toFixed(3) });
        assert.equal(await focusOf(page), null, `resting view not reached after ${n} notches`);
        within(atMax, 0, 1, 'notches with the camera at its farthest distance');
        within(home, ...HOME_BAND, 'overview distance / resting distance');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('two-finger pan: a horizontal wheel moves the target, does not zoom; a later notch zooms', async (t) => {
    const { page, errors } = await open(browser, DOCS.library);
    try {
        await page.mouse.move(800, 500);
        const target0 = await page.evaluate(() => ({ ...window.archMap.scene.controls.target }));
        const d0 = await distance(page);
        const f0 = await focusOf(page);
        for (let k = 0; k < 6; k++) { await page.mouse.wheel(30, 0); await sleep(16); }
        await page.mouse.wheel(0, 8); // the vertical tail a trackpad pan ends with
        await sleep(600);
        const target1 = await page.evaluate(() => ({ ...window.archMap.scene.controls.target }));
        const moved = Math.hypot(target1.x - target0.x, target1.y - target0.y, target1.z - target0.z);
        const d1 = await distance(page);
        const f1 = await focusOf(page);
        // the 200 ms pan latch ends, then a mouse notch zooms
        await sleep(400);
        const a = await aim(page, 'library.api');
        if (a) await page.mouse.move(a.x, a.y);
        await page.mouse.wheel(0, -100);
        await sleep(900);
        const d2 = await distance(page);
        measure(t, { moved: +moved.toFixed(1), dDistance: +(d1 - d0).toFixed(3), before: +d1.toFixed(1), afterNotch: +d2.toFixed(1) });
        assert.ok(moved > 5, `target moved ${moved}`);
        assert.ok(Math.abs(d1 - d0) < 0.5, `camera distance changed by ${d1 - d0} while panning`);
        assert.equal(f1, f0, 'focus changed while panning');
        assert.ok(d2 < d1 - 1, `a notch after the pan did not zoom: ${d1} → ${d2}`);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});
