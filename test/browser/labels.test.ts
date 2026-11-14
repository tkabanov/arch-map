// Names and tiles at rest with real hover (P1-1): in every project of the manifest, on the resting client layer, every
// named block can be pointed at on its tile and on its name, and each gives that block's own card; pointing at empty
// space hides the card. A name in a dense grid that stood over the tile behind used to take that tile's pointer and
// give the neighbour's card; a card placed by the tile alone landed over the hovered name and stayed stale.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, measure, sleep, BASE } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

type Pt = { x: number; y: number };
interface Named { id: string; title: string; tile: Pt | null; name: Pt }

/** The projects the viewer serves (projects.json), the default first. */
async function projects(): Promise<string[]> {
    const r = await fetch(BASE + '/specs/projects.json');
    const m = (await r.json()) as { default: string; projects: { name: string }[] };
    return [m.default, ...m.projects.map((p) => p.name).filter((n) => n !== m.default)];
}

/**
 * The blocks named now (not plates) inside the map: a point on the tile that picks to the block and the middle of its
 * name's title.
 */
const named = (page: Page) => page.evaluate(() => {
    type V = { label: { visible: boolean; element: HTMLElement }; node: { _plate?: boolean; title: string } };
    const a = window.archMap;
    const s = a.scene as unknown as { nodes: Map<string, V> } & typeof a.scene;
    const stage = mapRoot().querySelector('#stage')!.getBoundingClientRect();
    const inStage = (p: { x: number; y: number }) => p.x > stage.left + 2 && p.x < stage.right - 2 && p.y > stage.top + 2 && p.y < stage.bottom - 2;
    // a point of the tile that picks to the block: its centre, else the first of a 5×5 sample of its box
    const pointOn = (id: string) => {
        const c = s.screenCenter(id), r = s.screenRect(id);
        const pts = c ? [c] : [];
        if (r) for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) pts.push({ x: r.x0 + (r.x1 - r.x0) * fx, y: r.y0 + (r.y1 - r.y0) * fy });
        return pts.find((p) => inStage(p) && s.pickAt(p.x, p.y)?.id === id) ?? null;
    };
    const out: { id: string; title: string; tile: { x: number; y: number } | null; name: { x: number; y: number } }[] = [];
    for (const [id, v] of s.nodes) {
        if (!v.label.visible || v.node._plate) continue;
        const b = v.label.element.querySelector('b')!.getBoundingClientRect();
        const name = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        if (b.width && inStage(name)) out.push({ id, title: v.node.title, tile: pointOn(id), name });
    }
    return out;
});

/** A point of the map with nothing under it (no block, relation, name or the open card). */
const emptySpot = (page: Page) => page.evaluate(() => {
    const st = mapRoot().querySelector('#stage')!.getBoundingClientRect();
    const layer = window.archMap.scene as unknown as { labels: { domElement: HTMLElement } };
    for (const fy of [0.12, 0.2, 0.3, 0.9, 0.5]) for (const fx of [0.5, 0.7, 0.85, 0.3, 0.15]) {
        const x = st.left + st.width * fx, y = st.top + st.height * fy;
        const el = mapRoot().elementFromPoint(x, y);
        const hit = window.archMap.scene.pickAt(x, y);
        if (el && layer.labels.domElement.contains(el) && !el.closest('[data-id],[data-edge],[data-env]') && (!hit || hit.type === 'layer')) return { x, y };
    }
    return null;
});
/** Rest on empty space (another spot when the open card covers it: the card keeps itself under the pointer). */
async function toEmpty(page: Page): Promise<void> {
    const p = await emptySpot(page);
    assert.ok(p, 'no empty spot on the map');
    await page.mouse.move(p.x, p.y, { steps: 6 });
    await sleep(REST_MS);
}

/** The hover and the card now. */
const now = (page: Page) => page.evaluate(() => {
    const c = mapRoot().querySelector<HTMLElement>('#card')!;
    return { hover: window.archMap.state.hover?.type === 'node' ? window.archMap.state.hover.id! : null, card: c.hidden ? null : (c.querySelector('.c-title')?.textContent ?? '') };
});

const REST_MS = 900; // the card's 150 ms delay, the aim grace (350 ms) and a frame or two

test('every named block at rest: its tile and its name give its own card; empty space hides it', async (t) => {
    for (const project of await projects()) {
        const { page, errors } = await open(browser, `?project=${project}`);
        const list = await named(page);
        assert.ok(list.length >= 2, `${project}: only ${list.length} named blocks at rest`);
        const wrong: string[] = [];
        let tiles = 0, names = 0;
        const check = async (what: string, n: Named, p: Pt) => {
            await page.mouse.move(p.x, p.y, { steps: 6 });
            await sleep(REST_MS);
            const s = await now(page);
            if (s.hover !== n.id || s.card !== n.title) wrong.push(`${what} of ${n.id}: hover ${s.hover}, card ${s.card}`);
        };
        for (const n of list) {
            if (!n.tile) {
                wrong.push(`tile of ${n.id}: no point of it picks to it`);
                continue;
            }
            await check('tile', n, n.tile);
            tiles++;
            await check('name', n, n.name);
            names++;
            // empty space after every block: the card goes, the hover is nothing
            await toEmpty(page);
            const s = await now(page);
            if (s.card !== null || s.hover !== null) wrong.push(`empty space after ${n.id}: hover ${s.hover}, card ${s.card}`);
        }
        // and straight from name to name, the way a person reads a row (no stop in empty space between) — but for a name
        // under the open card: a pointer that arrives on the card keeps it (card-aim), so that one is reached from empty space
        let straight = 0, underCard = 0;
        for (const n of list) {
            const covered = await page.evaluate(({ x, y }) => {
                const c = mapRoot().querySelector<HTMLElement>('#card')!, r = c.getBoundingClientRect();
                return !c.hidden && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            }, n.name);
            if (covered) {
                underCard++;
                await toEmpty(page);
            } else straight++;
            await check('name (straight)', n, n.name);
        }
        measure(t, { project, named: list.length, tiles, names, straight, underCard, wrong: wrong.length });
        assert.deepEqual(wrong, [], `${project}: ${wrong.length} wrong hovers`);
        assert.deepEqual(errors, []);
        await page.close();
    }
});

test('selecting a block keeps the other names, dimmed (P3-4)', async (t) => {
    const { page, errors } = await open(browser);
    const names = () => page.evaluate(() => {
        const s = window.archMap.scene as unknown as { nodes: Map<string, { label: { visible: boolean; element: HTMLElement }; node: { _plate?: boolean } }> };
        const out = { shown: 0, unlit: 0 };
        for (const v of s.nodes.values()) if (v.label.visible && !v.node._plate) {
            out.shown++;
            if (v.label.element.classList.contains('unlit')) out.unlit++;
        }
        return out;
    });
    const atRest = await names();
    const list = await named(page);
    const target = list.find((n) => n.tile);
    assert.ok(target, 'no named tile to click');
    await page.mouse.move(target.tile!.x, target.tile!.y, { steps: 4 });
    await page.mouse.click(target.tile!.x, target.tile!.y);
    await sleep(1500);
    const picked = await names();
    const selected = await page.evaluate(() => window.archMap.state.selected?.id ?? null);
    measure(t, { target: target.id, selected, atRest, picked });
    assert.equal(selected, target.id);
    assert.ok(picked.shown >= atRest.shown - 1, `names ${atRest.shown} → ${picked.shown} on selecting ${target.id}`);
    assert.ok(picked.unlit >= 1, 'no dimmed names beside the selection');
    assert.deepEqual(errors, []);
    await page.close();
});

/** Every visible block name now: the middle of its title, and what a pointer there picks. */
const namePicks = (page: Page) => page.evaluate(() => {
    type V = { label: { visible: boolean; element: HTMLElement }; node: { _plate?: boolean } };
    const s = window.archMap.scene as unknown as { nodes: Map<string, V> } & typeof window.archMap.scene;
    const stage = mapRoot().querySelector('#stage')!.getBoundingClientRect();
    const out: { id: string; x: number; y: number; pick: string | null }[] = [];
    for (const [id, v] of s.nodes) {
        if (!v.label.visible || v.node._plate) continue;
        const b = v.label.element.querySelector('b')?.getBoundingClientRect();
        if (!b?.width) continue;
        const x = b.left + b.width / 2, y = b.top + b.height / 2;
        if (x < stage.left + 4 || x > stage.right - 4 || y < stage.top + 4 || y > stage.bottom - 4) continue;
        const el = mapRoot().elementFromPoint(x, y);
        if (!el?.closest('[data-id]')) continue; // covered by a bar or a card
        out.push({ id, x, y, pick: s.pickAt(x, y)?.id ?? null });
    }
    return out;
});

test('scenario steps: a name over another block never names one block and acts on another (hover, click, double-click)', async (t) => {
    const report: unknown[] = [];
    for (const project of await projects()) {
        const { page, errors } = await open(browser, `?project=${project}`);
        const sc = await page.evaluate(() => window.archMap.scenarios[0] ?? null);
        if (!sc) {
            await page.close();
            continue;
        }
        const play = async (step: number) => {
            await page.evaluate(() => (window.archMap as unknown as { select(h: null): void }).select(null));
            await page.evaluate(([id, k]) => window.archMap.scenario(id as string, k as number), [sc.id, step]);
            await sleep(1800);
        };
        let names = 0, foreign = 0, acted = 0;
        const wrong: string[] = [];
        for (let step = 1; step <= sc.steps.length; step++) {
            await play(step);
            const list = await namePicks(page);
            names += list.length;
            const over = list.filter((n) => n.pick !== n.id);
            foreign += over.length;
            // real input on the names over another block, and on one more name of the step
            for (const n of [...over, ...list.filter((x) => x.pick === x.id).slice(0, 1)]) {
                const focus0 = await page.evaluate(() => window.archMap.state.focus);
                await page.mouse.move(n.x, n.y, { steps: 4 });
                await sleep(REST_MS);
                const hover = await now(page);
                await page.mouse.click(n.x, n.y);
                await sleep(400);
                const clicked = await page.evaluate(() => window.archMap.state.selected?.id ?? null);
                await play(step);
                await page.mouse.move(n.x, n.y, { steps: 2 });
                await page.mouse.dblclick(n.x, n.y);
                await sleep(500);
                const dbl = await page.evaluate(() => ({ focus: window.archMap.state.focus, selected: window.archMap.state.selected?.id ?? null }));
                const entered = dbl.focus !== focus0 ? dbl.focus : dbl.selected;
                acted++;
                const got = { hover: hover.hover, clicked, entered };
                if (got.hover !== n.pick || got.clicked !== n.pick || got.entered !== n.pick) wrong.push(`step ${step} name of ${n.id} (picks ${n.pick}): ${JSON.stringify(got)}`);
                await page.evaluate((f) => window.archMap.setFocus(f), focus0);
                await play(step);
            }
        }
        report.push({ project, steps: sc.steps.length, names, foreign, acted, wrong: wrong.length });
        assert.deepEqual(wrong, [], `${project}: ${wrong.length} names act on another block`);
        assert.deepEqual(errors, []);
        await page.close();
    }
    measure(t, report);
});
