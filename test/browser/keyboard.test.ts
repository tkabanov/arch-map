// The map from the keyboard alone (P1-2), in every project the viewer serves: Tab reaches the map; the arrow keys select
// its blocks in reading order with a ring on the block and the selection said in `#sr-status` («Task platform, system,
// 27 parts, 5 endpoints, 2 of 3»); Enter goes into a block, the arrows then select its blocks; Tab goes on to the
// panel, which shows the selected block's details; Esc comes back to the map and steps out, each step said. Shift +
// arrows pan, the plain arrows do not; Enter on a block with nothing inside brings its details into the focus.
// Nothing here uses the pointer or the debug API to act: it only reads the state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, measure, sleep, BASE } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

/** The projects the viewer serves (projects.json), the default first. */
async function projects(): Promise<string[]> {
    const m = (await (await fetch(BASE + '/specs/projects.json')).json()) as { default: string; projects: { name: string }[] };
    return [m.default, ...m.projects.map((p) => p.name).filter((n) => n !== m.default)];
}

/** What the keyboard check reads: the focus, the selection, what it is, the status line, who has the keyboard, the ring. */
const now = (page: Page) => page.evaluate(() => {
    type Box = { x0: number; y0: number; x1: number; y1: number };
    const a = window.archMap as unknown as {
        state: { focus: string | null; selected: { type: string; id: string } | null };
        model: { nodes: Map<string, { title: string; parent: string | null; children: unknown[] }> };
        scene: { screenRect(id: string): Box | null; controls: { target: { x: number; y: number; z: number } } };
    };
    const sel = a.state.selected?.type === 'node' ? a.state.selected.id : null;
    const n = sel ? a.model.nodes.get(sel) : undefined;
    /** The ring is shown and holds the block's middle. */
    const ringOn = (): boolean => {
        const ring = mapRoot().querySelector<HTMLElement>('#kbring')!;
        const br = sel ? a.scene.screenRect(sel) : null;
        if (ring.hidden || !br) return false;
        const rr = ring.getBoundingClientRect(), x = (br.x0 + br.x1) / 2, y = (br.y0 + br.y1) / 2;
        return rr.left <= x && x <= rr.right && rr.top <= y && y <= rr.bottom;
    };
    /** The selection is inside the block you are in. */
    const inside = (): boolean => {
        for (let p = n?.parent ?? null; p; p = a.model.nodes.get(p)?.parent ?? null) if (p === a.state.focus) return true;
        return false;
    };
    const holder = (): string => {
        const ae = mapRoot().activeElement as HTMLElement | null; // null: the focus is outside the map (on the page)
        if (!ae || ae === document.body) return 'BODY';
        return ae.closest('#panel') ? 'panel' : ae.classList.contains('labels') ? 'map' : ae.tagName;
    };
    const { x, y, z } = a.scene.controls.target;
    return {
        focus: a.state.focus,
        sel,
        title: n?.title ?? null,
        kids: n?.children.length ?? 0,
        inside: inside(),
        sr: mapRoot().querySelector('#sr-status')!.textContent!,
        active: holder(),
        panelTitle: mapRoot().querySelector('#panel h3')?.textContent?.trim() ?? null,
        ring: ringOn(),
        target: [x, y, z],
    };
});
type Now = Awaited<ReturnType<typeof now>>;

/** Presses `key`, waits, returns the state after it. */
async function press(page: Page, key: string, ms = 350): Promise<Now> {
    await page.keyboard.press(key);
    await sleep(ms);
    return now(page);
}

/** Tab from the top of the page until the map has the keyboard; the number of presses. */
async function tabToMap(page: Page): Promise<number> {
    for (let i = 1; i <= 25; i++) {
        await page.keyboard.press('Tab');
        if ((await now(page)).active === 'map') return i;
    }
    throw new Error('Tab never reached the map');
}

/** → until `want` holds for the selection (at most one round of the blocks); the states seen on the way. */
async function roveUntil(page: Page, want: (s: Now) => boolean): Promise<{ hit: Now | null; seen: Now[] }> {
    const seen: Now[] = [];
    for (let i = 0; i < 40; i++) {
        const s = await press(page, 'ArrowRight');
        seen.push(s);
        if (want(s)) return { hit: s, seen };
        if (i > 0 && s.sel === seen[0].sel) break; // round the whole map
    }
    return { hit: null, seen };
}

/** Each selection said: the title, the kind, «k of n». */
function assertSaid(s: Now, what: string): void {
    assert.ok(s.sel, `${what}: nothing selected`);
    assert.match(s.sr, new RegExp(`^${s.title!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, [^,]+(, \\d+ (parts?|endpoints?))*, \\d+ of \\d+$`), `${what}: said «${s.sr}»`);
    assert.equal(s.active, 'map', `${what}: the keyboard left the map`);
    assert.ok(s.ring, `${what}: no ring around ${s.sel}`);
}

test('keyboard only: map → a system → Enter → a block inside → its details in the panel → Esc out, each step said', async (t) => {
    let full = 0;
    for (const project of await projects()) {
        const { page, errors } = await open(browser, `?project=${project}`);
        const log: Record<string, unknown> = { project, tabs: await tabToMap(page) };
        // a block that has blocks inside
        const sys = await roveUntil(page, (s) => s.kids > 0);
        for (const s of sys.seen) assertSaid(s, `${project}: rest`);
        log.rest = sys.seen.map((s) => s.sr);
        if (!sys.hit) {
            log.note = 'no block with parts at rest';
            measure(t, log);
            await page.close();
            continue;
        }
        const entered = await press(page, 'Enter', 2500);
        assert.equal(entered.focus, sys.hit.sel, `${project}: Enter did not go into ${sys.hit.sel}`);
        assert.equal(entered.sr, `Inside ${sys.hit.title}`);
        assert.equal(entered.active, 'map');
        // a block inside it
        const mod = await roveUntil(page, (s) => s.inside);
        assert.ok(mod.hit, `${project}: no block inside ${sys.hit.sel} reachable by the arrows`);
        for (const s of mod.seen) assertSaid(s, `${project}: inside`);
        // its details: Tab goes on to the panel, which shows the block
        const details = await press(page, 'Tab');
        assert.equal(details.active, 'panel', `${project}: Tab from the map went to ${details.active}`);
        assert.equal(details.panelTitle, mod.hit.title, `${project}: the panel shows ${details.panelTitle}`);
        // Esc: back to the map, the selection steps out to the block you are in, then out to the overview
        const back = await press(page, 'Escape', 600);
        assert.equal(back.active, 'map', `${project}: Esc in the panel left the keyboard on ${back.active}`);
        assert.equal(back.sel, sys.hit.sel);
        assert.match(back.sr, new RegExp(`^${sys.hit.title!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, `));
        const out = await press(page, 'Escape', 2500);
        assert.equal(out.focus, null, `${project}: Esc did not step out`);
        assert.equal(out.sr, 'Back to the overview');
        assert.equal(out.active, 'map');
        Object.assign(log, { system: sys.hit.sr, entered: entered.sr, module: mod.hit.sr, panel: details.panelTitle, back: back.sr, out: out.sr });
        measure(t, log);
        full++;
        assert.deepEqual(errors, []);
        await page.close();
    }
    assert.ok(full >= 1, 'no project went the whole way');
});

test('Enter on a block with nothing inside brings its details into focus; Esc gives the keyboard back to the map', async (t) => {
    let done = 0;
    for (const project of await projects()) {
        const { page, errors } = await open(browser, `?project=${project}`);
        await tabToMap(page);
        const leaf = await roveUntil(page, (s) => s.kids === 0);
        if (!leaf.hit) {
            await page.close();
            continue;
        }
        const d = await press(page, 'Enter', 600);
        assert.equal(d.active, 'panel', `${project}: Enter on ${leaf.hit.sel} left the keyboard on ${d.active}`);
        assert.equal(d.panelTitle, leaf.hit.title);
        assert.equal(await page.evaluate(() => mapRoot().activeElement?.tagName), 'H3', 'the details are read from their title');
        const back = await press(page, 'Escape', 600);
        assert.equal(back.active, 'map');
        assert.equal(back.sel, null);
        assert.equal(back.sr, 'Nothing selected');
        measure(t, { project, leaf: leaf.hit.sr, panel: d.panelTitle, back: back.sr });
        done++;
        assert.deepEqual(errors, []);
        await page.close();
    }
    assert.ok(done >= 1, 'no project has a block without parts at rest');
});

test('Shift + arrows pan, the plain arrows select and do not pan; Tab from the map never falls to the page', async (t) => {
    const { page, errors } = await open(browser);
    await tabToMap(page);
    const t0 = (await now(page)).target;
    const sel = await press(page, 'ArrowRight');
    const t1 = sel.target;
    const panned = await press(page, 'Shift+ArrowLeft', 500);
    const moved = Math.hypot(...panned.target.map((v, i) => v - t1[i]));
    assert.deepEqual(t1, t0, 'a plain arrow moved the camera');
    assert.ok(moved > 0.5, `Shift+← moved the camera target by ${moved}`);
    assert.equal(panned.sel, sel.sel, 'Shift+← changed the selection');
    // Tab from the map: at rest, with a block selected, inside a block — always into the panel
    const where: string[] = [];
    for (const step of ['Escape', 'ArrowRight', 'Enter']) {
        await page.focus('#stage .labels');
        await press(page, step, step === 'Enter' ? 2500 : 400);
        if ((await now(page)).active !== 'map') await page.focus('#stage .labels'); // Enter on a leaf went to the panel
        where.push((await press(page, 'Tab')).active);
    }
    measure(t, { moved: +moved.toFixed(2), tab: where });
    assert.deepEqual(where, ['panel', 'panel', 'panel']);
    assert.deepEqual(errors, []);
    await page.close();
});
