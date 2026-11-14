// Pointer checks with real input: hover card, click at a block's centre from four directions (the block is
// selected, not an edge chip or the card), the hover card's own button, click → the relations light up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, focus, resolveId, within, measure, sleep, DOCS } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const DIRS: [string, number, number][] = [['up-left', -60, -60], ['left', -80, 0], ['below', 0, 80], ['right', 80, 0]];
/** [stack, docs query, focus, block] */
const CASES: [string, string, string, string][] = [
    ['tasks-supabase', DOCS.tasks, 'tasks.db.task', 'tasks.db.task.comments'],
    ['library-nest', DOCS.library, 'library.db', 'library.db.loans'],
];

/** Open `qs`, focus `parent`, and return the screen centre of `block` (resolved to a real id). */
async function at(qs: string, parent: string, block: string) {
    const o = await open(browser, qs);
    await focus(o.page, parent);
    const id = await resolveId(o.page, block);
    assert.ok(id, `no node ${block}`);
    const c = await o.page.evaluate((b) => window.archMap.scene.screenCenter(b), id);
    assert.ok(c, `${id} is not on screen`);
    return { ...o, id, c };
}

/** Come from (dx, dy) and rest at the centre (6 steps), as a hand does. */
async function approach(page: Page, c: { x: number; y: number }, dx: number, dy: number, rest = 900) {
    await page.mouse.move(c.x + dx, c.y + dy);
    await sleep(300);
    await page.mouse.move(c.x, c.y, { steps: 6 });
    await sleep(rest);
}

for (const [stack, qs, parent, block] of CASES) {
    for (const [dir, dx, dy] of DIRS) {
        test(`centre click selects the block: ${stack} ${block} from ${dir}`, async (t) => {
            const { page, errors, id, c } = await at(qs, parent, block);
            try {
                await approach(page, c, dx, dy);
                const hover = await page.evaluate(() => window.archMap.state.hover?.id ?? null);
                const under = await page.evaluate(({ x, y }) => {
                    const el = mapRoot().elementFromPoint(x, y);
                    return el?.closest('#card') ? 'card' : el?.tagName.toLowerCase() ?? null;
                }, c);
                await page.mouse.click(c.x, c.y);
                await sleep(900);
                const selected = await page.evaluate(() => window.archMap.state.selected?.id ?? null);
                measure(t, { id, hover, under, selected });
                assert.notEqual(under, 'card', 'the hover card is under the pointer');
                assert.equal(hover, id, 'the hover is not the block under the resting pointer');
                assert.equal(selected, id);
                assert.deepEqual(errors, []);
            } finally {
                await page.close();
            }
        });
    }
}

test('hover card: comments shows its card; click lights its relations', async (t) => {
    const { page, errors, id, c } = await at(DOCS.tasks, 'tasks.db.task', 'tasks.db.task.comments');
    try {
        await approach(page, c, -40, -40);
        const card = await page.evaluate(() => {
            const el = mapRoot().querySelector<HTMLElement>('#card')!;
            return {
                hover: window.archMap.state.hover?.id ?? null,
                hidden: el.hidden,
                title: el.querySelector('.c-title')?.textContent ?? null,
                stats: el.querySelector('.c-stats')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
            };
        });
        await page.mouse.click(c.x, c.y);
        await sleep(900);
        const click = await page.evaluate(() => {
            const a = window.archMap;
            return { selected: a.state.selected?.id ?? null, lit: a.scene.view.lit?.size ?? 0, litEdges: a.scene.view.litEdges?.size ?? 0, panel: mapRoot().querySelector('#panel h2, #panel h3, #panel .p-title')?.textContent ?? null };
        });
        measure(t, { card, click });
        assert.equal(card.hover, id);
        assert.equal(card.hidden, false);
        assert.equal(card.title, 'comments');
        assert.match(card.stats ?? '', /\d+ callers? · \d+ calls?/);
        assert.equal(click.selected, id);
        assert.equal(click.panel, 'comments');
        within(click.lit, 13, 15, 'lit blocks', click);
        within(click.litEdges, 4, 6, 'lit relations', click);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

// From up-left the pointer crosses tasks.edge.task and tasks.db.task.boards on its way in: the hover must follow it to the block
// it rests on (before 125ee20 it stayed on tasks.db.task.boards and the card hid — the stale hover).
for (const [dir, dx, dy] of DIRS) {
    test(`hover card button: the card stays while the pointer moves onto it, its button works (from ${dir})`, async (t) => {
        const { page, errors, id, c } = await at(DOCS.tasks, 'tasks.db.task', 'tasks.db.task.comments');
        try {
            await approach(page, c, dx, dy, 1500);
            const b = await page.evaluate(() => {
                const card = mapRoot().querySelector<HTMLElement>('#card')!;
                const e = [...card.querySelectorAll<HTMLElement>('button[data-path], button[data-select]')].pop();
                if (!e || card.hidden) return null;
                const r = e.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2, path: e.hasAttribute('data-path') };
            });
            assert.ok(b, 'no card button');
            await page.mouse.move(b.x, b.y, { steps: 12 });
            await sleep(400);
            const stays = await page.evaluate(() => !mapRoot().querySelector<HTMLElement>('#card')!.hidden);
            await page.mouse.click(b.x, b.y);
            await sleep(1200);
            const result = await page.evaluate(() => ({ selected: window.archMap.state.selected?.id ?? null, path: window.archMap.state.path?.title ?? null }));
            measure(t, { button: b.path ? 'path' : 'select', stays, result });
            assert.ok(stays, 'the card closed on the way to its button');
            if (b.path) assert.ok(result.path, 'the Path button opened no Path');
            else assert.equal(result.selected, id);
            assert.deepEqual(errors, []);
        } finally {
            await page.close();
        }
    });
}
