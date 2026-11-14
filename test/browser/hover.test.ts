// Hover with real input past a neighbour's card (2a) and after the camera moved under a still pointer (2b).
// 2a: rest on a neighbour of the target until its card shows, then move to the target's centre and rest — the hover and
//     the click land on the target, never on the neighbour's card; and a card never covers a block's centre when a
//     free side was there to take. 2b: the pointer rests on a block, the wheel moves another block under it — once the
//     camera rests, the hover is the block under the pointer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, focus, resolveId, measure, sleep, DOCS, NOTCH_MS } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

type Box = { x0: number; y0: number; x1: number; y1: number };
interface Neighbour { id: string; c: { x: number; y: number }; dir: string }

/** [stack, docs query, focus, target] — the click checks' blocks. */
const CASES: [string, string, string, string][] = [
    ['tasks-supabase', DOCS.tasks, 'tasks.db.task', 'tasks.db.task.comments'],
    ['library-nest', DOCS.library, 'library.db', 'library.db.loans'],
];

/**
 * The blocks on screen (not plates, not ghosts) with their boxes. Probed through `scene.nodes` / `scene.screenRect`
 * (the debug API is loose on purpose).
 */
const blocksOnScreen = (page: Page) => page.evaluate(() => {
    const s = window.archMap.scene as unknown as { nodes: Map<string, { ghost?: boolean; obj: { visible: boolean }; node: { _plate?: boolean } }>; screenRect(id: string): Box | null };
    const out: { id: string; b: Box }[] = [];
    for (const [id, v] of s.nodes) {
        if (v.ghost || v.node._plate || !v.obj.visible) continue;
        const b = s.screenRect(id);
        if (b && b.x1 > 0 && b.y1 > 0 && b.x0 < innerWidth && b.y0 < innerHeight && b.x1 - b.x0 > 8 && b.y1 - b.y0 > 8) out.push({ id, b });
    }
    return out;
});

const centre = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const inside = (p: { x: number; y: number }, b: Box) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
const DIR = (dx: number, dy: number) => (Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'above' : 'below');

/** Up to 4 neighbours of `target` whose centre picks to themselves, the nearest in each direction (left/right/above/below). */
async function neighbours(page: Page, target: string): Promise<Neighbour[]> {
    const all = await blocksOnScreen(page);
    const t = all.find((x) => x.id === target);
    assert.ok(t, `${target} is not on screen`);
    const tc = centre(t.b);
    const out = new Map<string, Neighbour>();
    for (const x of all.filter((x) => x.id !== target).sort((a, b) => Math.hypot(centre(a.b).x - tc.x, centre(a.b).y - tc.y) - Math.hypot(centre(b.b).x - tc.x, centre(b.b).y - tc.y))) {
        const c = centre(x.b);
        const dir = DIR(c.x - tc.x, c.y - tc.y);
        if (out.has(dir) || inside(c, t.b)) continue;
        const hit = await page.evaluate(({ x, y }) => window.archMap.scene.pickAt(x, y)?.id ?? null, c);
        if (hit === x.id) out.set(dir, { id: x.id, c, dir });
    }
    return [...out.values()];
}

/** The card now: hidden, its title, its box. */
const cardNow = (page: Page) => page.evaluate(() => {
    const el = mapRoot().querySelector<HTMLElement>('#card')!;
    const r = el.getBoundingClientRect();
    return { hidden: el.hidden, title: el.querySelector('.c-title')?.textContent ?? null, box: { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }, sides: el.dataset.sides ?? null };
});

const titleOf = (page: Page, id: string) => page.evaluate((i) => (window.archMap.model.nodes.get(i) as unknown as { title: string })?.title ?? null, id);

for (const [stack, qs, parent, block] of CASES) {
    test(`past a neighbour's card: ${stack} ${block} — hover and click land on the target, cards spare free centres`, async (t) => {
        const { page, errors } = await open(browser, qs);
        try {
            await focus(page, parent);
            const id = await resolveId(page, block);
            assert.ok(id);
            const title = await titleOf(page, id);
            const ns = await neighbours(page, id);
            assert.ok(ns.length >= 2, `only ${ns.length} neighbours on screen`);
            const rows = [];
            for (const n of ns) {
                for (const steps of [3, 12]) {
                    await page.mouse.move(n.c.x, n.c.y, { steps: 4 });
                    await sleep(900); // the neighbour's card shows
                    const shown = await cardNow(page);
                    const blocks = await blocksOnScreen(page);
                    const tb = blocks.find((x) => x.id === id)!.b;
                    const tc = centre(tb);
                    // centres (middle half) of other blocks the neighbour's card covers
                    const mid = (b: Box) => ({ x0: b.x0 + (b.x1 - b.x0) / 4, y0: b.y0 + (b.y1 - b.y0) / 4, x1: b.x1 - (b.x1 - b.x0) / 4, y1: b.y1 - (b.y1 - b.y0) / 4 });
                    const over = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
                    const covers = shown.hidden ? [] : blocks.filter((x) => x.id !== n.id && over(shown.box, mid(x.b))).map((x) => x.id);
                    await page.mouse.move(tc.x, tc.y, { steps });
                    await sleep(900);
                    const after = await page.evaluate(({ x, y }) => {
                        const el = mapRoot().elementFromPoint(x, y);
                        return { hover: window.archMap.state.hover?.id ?? null, under: el?.closest('#card') ? 'card' : el?.tagName.toLowerCase() ?? null };
                    }, tc);
                    const card = await cardNow(page);
                    await page.mouse.click(tc.x, tc.y);
                    await sleep(700);
                    const selected = await page.evaluate(() => window.archMap.state.selected?.id ?? null);
                    // a side the card could have taken that covers nothing (`data-sides`: side:cost, '-' = does not fit)
                    const freeSide = !!shown.sides && /:0(\s|$)/.test(shown.sides);
                    rows.push({ from: n.dir, n: n.id, steps, cardOf: shown.hidden ? null : shown.title, coversTarget: covers.includes(id), freeSide, sides: shown.sides, covers: covers.length, ...after, card: card.hidden ? null : card.title, selected });
                    await page.keyboard.press('Escape'); // drop the selection (the focus stays: Escape first clears a selection)
                    await sleep(400);
                    if (await page.evaluate(() => window.archMap.state.focus) !== (await resolveId(page, parent))) await focus(page, parent);
                }
            }
            const bad = rows.filter((r) => r.hover !== id || r.under === 'card' || r.selected !== id || (r.card !== null && r.card !== title));
            const coverFree = rows.filter((r) => r.coversTarget && r.freeSide);
            measure(t, { id, neighbours: ns.map((n) => `${n.dir}:${n.id}`), ok: rows.length - bad.length, of: rows.length, coversTarget: rows.filter((r) => r.coversTarget).length, coverFree: coverFree.length, rows });
            assert.equal(bad.length, 0, `stale hover/card: ${JSON.stringify(bad)}`);
            assert.equal(coverFree.length, 0, `a neighbour's card covers the target's centre although a free side was there: ${JSON.stringify(coverFree)}`);
            assert.deepEqual(errors, []);
        } finally {
            await page.close();
        }
    });
}

test('hover after camera motion: a wheel pan moves another block under a still pointer → the hover follows at rest', async (t) => {
    const { page, errors } = await open(browser, DOCS.tasks);
    try {
        await focus(page, 'tasks.db.task');
        const blocks = await blocksOnScreen(page);
        const rows = [];
        // Probe table edges with a horizontal wheel pan: unlike cursor-anchored zoom, this moves the small map under a still pointer.
        for (const x of blocks.filter((block) => block.id.startsWith('tasks.db.task.'))) {
            for (const [fx, fy] of [[0.12, 0.5], [0.88, 0.5], [0.5, 0.12], [0.5, 0.88]]) {
                const p = { x: x.b.x0 + (x.b.x1 - x.b.x0) * fx, y: x.b.y0 + (x.b.y1 - x.b.y0) * fy };
                await page.mouse.move(p.x, p.y, { steps: 3 });
                await sleep(500);
                const was = await page.evaluate(() => window.archMap.state.hover?.id ?? null);
                if (was !== x.id) continue;
                await page.mouse.wheel(60, 0);
                await sleep(NOTCH_MS + 1500); // the zoom eases out and the camera rests
                const now = await page.evaluate(({ x, y }) => ({ hover: window.archMap.state.hover?.id ?? null, under: window.archMap.scene.pickAt(x, y)?.type === 'node' ? window.archMap.scene.pickAt(x, y)!.id ?? null : null, focus: window.archMap.state.focus }), p);
                // Only record a block under the pointer at the same focus level.
                if (now.under && now.under !== was && now.focus === 'tasks.db.task') rows.push({ was, under: now.under, hover: now.hover, focus: now.focus });
                // back to where it was, for the next spot
                await page.evaluate(() => window.archMap.setFocus(null));
                await sleep(1500);
                await focus(page, 'tasks.db.task');
                if (rows.length >= 3) break;
            }
            if (rows.length >= 3) break;
        }
        const stale = rows.filter((r) => r.hover !== r.under);
        measure(t, { moved: rows.length, followed: rows.length - stale.length, rows });
        assert.ok(rows.length >= 1, 'no wheel pan moved another block under the pointer');
        assert.equal(stale.length, 0, `the hover stayed on the old block: ${JSON.stringify(stale)}`);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});
