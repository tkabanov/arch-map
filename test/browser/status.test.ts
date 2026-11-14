// The status line under the map (P2-2) with real clicks on the legend: it says what the filters hide now (and the
// specs' unresolved calls), not the renderer's counters — those stay on the debug API (`archMap.stats`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, measure, sleep, NOTCH_MS } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const status = (page: Page) => page.evaluate(() => [...mapRoot().querySelectorAll('#status > span')].map((s) => s.textContent!.replace(/\s+/g, ' ').trim()));
const hidden = (lines: string[]) => Number(lines.find((l) => /hidden by filters/.test(l))?.match(/^(\d+)/)?.[1] ?? 0);

test('status line: the relations a legend filter hides come and go with the filter; the counters are on the debug API', async (t) => {
    const { page, errors } = await open(browser);
    const atRest = await status(page);
    assert.ok(!atRest.some((l) => /^(Blocks|in frame|labels|relations):/.test(l)), `dev counters in the status line: ${atRest.join(' | ')}`);
    const stats = await page.evaluate(() => (window.archMap as unknown as { stats: Record<string, number> }).stats);
    for (const k of ['nodes', 'inView', 'labels', 'edges', 'of']) assert.equal(typeof stats[k], 'number', `archMap.stats.${k}`);
    // the legend open, the first kind that is on (and drawn at rest) turned off and on again with real clicks
    await page.click('#legend summary');
    const kinds = await page.$$eval('#legend [data-kind][aria-pressed="true"]', (l) => l.map((x) => (x as HTMLElement).dataset.kind!));
    let off: { kind: string; hidden: number } | null = null;
    for (const kind of kinds) {
        await page.click(`#legend [data-kind="${kind}"]`);
        await sleep(600);
        const n = hidden(await status(page));
        await page.click(`#legend [data-kind="${kind}"]`);
        await sleep(600);
        if (n) {
            off = { kind, hidden: n };
            break;
        }
    }
    const back = await status(page);
    measure(t, { atRest, stats, off, back });
    assert.ok(off, 'no legend kind hides anything at rest');
    assert.equal(hidden(back), hidden(atRest), 'turned back on, the count is as before');
    assert.deepEqual(errors, []);
    await page.close();
});

test('the zoom hint goes when the wheel turns the other way (P3-7)', async (t) => {
    const { page, errors } = await open(browser);
    const hint = () => page.evaluate(() => {
        const h = mapRoot().querySelector<HTMLElement>('#zoomhint')!;
        return h.hidden ? null : h.textContent!.trim();
    });
    // empty map space beside the blocks: the wheel there zooms toward the nearest block, and the hint says so
    const spot = await page.evaluate(() => {
        const st = mapRoot().querySelector('#stage')!.getBoundingClientRect();
        for (const fy of [0.3, 0.5, 0.7, 0.2]) for (const fx of [0.9, 0.8, 0.1, 0.2]) {
            const x = st.left + st.width * fx, y = st.top + st.height * fy;
            const hit = window.archMap.scene.pickAt(x, y);
            if (!hit || hit.type === 'layer') return { x, y };
        }
        return null;
    });
    assert.ok(spot, 'no empty spot');
    await page.mouse.move(spot.x, spot.y);
    let toward: string | null = null, notches = 0;
    for (; notches < 20 && !toward; notches++) {
        await page.mouse.wheel(0, -100);
        await sleep(NOTCH_MS);
        const h = await hint();
        if (h && /^Zooming toward/.test(h)) toward = h;
    }
    assert.ok(toward, `no "Zooming toward" hint after ${notches} notches in`);
    // one notch the other way: the hint about zooming in goes with that very notch (not at the next zoom decision,
    // which waits while the camera flies or right after a level change)
    await page.mouse.wheel(0, 100);
    await sleep(40);
    const afterOut = await hint();
    measure(t, { notches, toward, afterOut });
    assert.ok(!afterOut || !/^Zooming toward/.test(afterOut), `after a notch out the hint still says: ${afterOut}`);
    assert.deepEqual(errors, []);
    await page.close();
});

/**
 * The hidden count, worked out independently from what is drawn: raw relations between two distinct placed blocks
 * (each folded to its nearest placed ancestor-or-self, neither inside the other, touching the focus when there is one)
 * that no drawn line carries.
 */
const hiddenOracle = (page: Page) => page.evaluate(() => {
    type N = { id: string; parent?: string | null };
    const a = window.archMap as unknown as { model: { nodes: Map<string, N>; edges: { id: string; from: string; to: string }[] }; state: { placedIds: Set<string>; focus: string | null; folded: { raw: { id: string }[] }[]; hiddenByFilters?: number } };
    const { model, state } = a;
    const up = (id: string): string[] => {
        const out: string[] = [];
        for (let n = model.nodes.get(id); n; n = n.parent ? model.nodes.get(n.parent) : undefined) out.push(n.id);
        return out;
    };
    const shown = (id: string) => up(id).find((x) => state.placedIds.has(x)) ?? null;
    const drawn = new Set(state.folded.flatMap((e) => e.raw.map((r) => r.id)));
    let n = 0;
    for (const e of model.edges) {
        const f = shown(e.from), t = shown(e.to);
        if (!f || !t || f === t || up(f).includes(t) || up(t).includes(f)) continue;
        if (state.focus && !up(e.from).includes(state.focus) && !up(e.to).includes(state.focus)) continue;
        if (!drawn.has(e.id)) n++;
    }
    return { shown: state.hiddenByFilters ?? 0, oracle: n };
});

test('status line: the hidden count is exact while a scenario restores its relations under a filter', async (t) => {
    const { page, errors } = await open(browser);
    const sc = await page.evaluate(() => window.archMap.scenarios[0] ?? null);
    assert.ok(sc, 'the default project has no scenario');
    await page.click('#legend summary');
    const kinds = await page.$$eval('#legend [data-kind][aria-pressed="true"]', (l) => l.map((x) => (x as HTMLElement).dataset.kind!));
    const seen: { kind: string; step: number; shown: number; oracle: number }[] = [];
    for (const kind of kinds) {
        await page.click(`#legend [data-kind="${kind}"]`); // off
        for (let step = 1; step <= sc.steps.length; step++) {
            await page.evaluate(([id, k]) => window.archMap.scenario(id as string, k as number), [sc.id, step]);
            await sleep(700);
            seen.push({ kind, step, ...(await hiddenOracle(page)) });
        }
        await page.evaluate(() => window.archMap.scenario());
        await sleep(500);
        await page.click(`#legend [data-kind="${kind}"]`); // back on
    }
    const wrong = seen.filter((s) => s.shown !== s.oracle);
    measure(t, { cases: seen.length, positive: seen.filter((s) => s.shown > 0).length, wrong });
    assert.ok(seen.some((s) => s.shown > 0), 'no filter hid anything during the scenario');
    assert.deepEqual(wrong, []);
    assert.deepEqual(errors, []);
    await page.close();
});
