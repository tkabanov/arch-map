// The first panel and the «?» sheet (P2-1, P2-8) with real input at 1440×900: the main scenario's button is above the
// fold on first load (in the client and the technical view); `?` and the header's «?» button open and close the sheet
// from any state — at rest, a block selected, inside a block, a scenario open, the cinema playing — and the Esc that
// closes the sheet changes nothing else. `?` typed into the search box stays text.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, measure, sleep, BASE } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const FOLD = { width: 1440, height: 900 };

/** The projects the viewer serves (projects.json), the default first. */
async function projects(): Promise<string[]> {
    const m = (await (await fetch(BASE + '/specs/projects.json')).json()) as { default: string; projects: { name: string }[] };
    return [m.default, ...m.projects.map((p) => p.name).filter((n) => n !== m.default)];
}

/** The main scenario's button: its box, its text; null when the project has no scenario. */
const cta = (page: Page) => page.evaluate(() => {
    const b = mapRoot().querySelector<HTMLElement>('#panel .sc-cta');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), text: b.textContent!.trim(), scenarios: window.archMap.scenarios.length };
});

const sheetOpen = (page: Page) => page.evaluate(() => mapRoot().querySelector<HTMLDialogElement>('#helpsheet')!.open);
/** What Esc would otherwise change: the focus, the selection, the scenario, the cinema. */
const where = (page: Page) => page.evaluate(() => {
    const a = window.archMap;
    return { focus: a.state.focus, selected: a.state.selected?.id ?? null, cinema: a.cinema.state.on, scenario: (a.state as unknown as { scenario: { id: string } | null }).scenario?.id ?? null };
});

test('first load at 1440×900: the main scenario button is above the fold, in both views', async (t) => {
    let withScenario = 0;
    for (const project of await projects()) {
        const { page, errors } = await open(browser, `?project=${project}`);
        await page.setViewportSize(FOLD);
        await sleep(600);
        const client = await cta(page);
        await page.evaluate(() => (window.archMap as unknown as { setView(v: string): void }).setView('tech'));
        await sleep(1500);
        const tech = await cta(page);
        measure(t, { project, client, tech });
        if (client) {
            withScenario++;
            assert.ok(client.top >= 56 && client.bottom <= FOLD.height, `${project}: the button at ${client.top}–${client.bottom}`);
            assert.match(client.text, /^▶ .+ \(\d+ steps\)$/);
            assert.ok(tech && tech.bottom <= FOLD.height, `${project}: in the technical view the button is at ${tech?.top}–${tech?.bottom}`);
        } else assert.equal(await page.evaluate(() => window.archMap.scenarios.length), 0, `${project}: scenarios but no button`);
        assert.deepEqual(errors, []);
        await page.close();
    }
    assert.ok(withScenario >= 1, 'no project with a scenario: the button went unchecked');
});

test('? opens and closes the sheet from any state; its Esc changes nothing else', async (t) => {
    const { page, errors } = await open(browser);
    await page.setViewportSize(FOLD);
    await sleep(600);
    const seen: Record<string, boolean[]> = {};
    /** `?` opens, `?` closes, `?` opens, Esc closes; the header button opens and closes; the state stays as it was. */
    const round = async (name: string) => {
        const was = await where(page);
        const s: boolean[] = [];
        await page.keyboard.press('?');
        s.push(await sheetOpen(page));
        await page.keyboard.press('?');
        s.push(await sheetOpen(page));
        await page.keyboard.press('?');
        s.push(await sheetOpen(page));
        await page.keyboard.press('Escape');
        await sleep(100);
        s.push(await sheetOpen(page));
        if (!(await where(page)).cinema) { // the cinema hides the header
            await page.click('#helpbtn');
            s.push(await sheetOpen(page));
            await page.mouse.click(12, 450); // the backdrop, outside the sheet's box
            s.push(await sheetOpen(page));
        }
        seen[name] = s;
        assert.deepEqual(s.slice(0, 4), [true, false, true, false], `${name}: ? ? ? Esc`);
        if (s.length > 4) assert.deepEqual(s.slice(4), [true, false], `${name}: the button, then a click outside`);
        assert.deepEqual(await where(page), was, `${name}: the Esc that closed the sheet changed the map`);
    };
    await page.mouse.move(700, 450);
    await round('rest');
    const block = await page.evaluate(() => [...window.archMap.model.nodes.values()].find((n) => !n.parent && (n as unknown as { children: unknown[] }).children.length)?.id ?? null);
    assert.ok(block);
    await page.evaluate((id) => (window.archMap as unknown as { select(h: unknown): void }).select({ type: 'node', id }), block);
    await sleep(500);
    await round('selected');
    await page.evaluate((id) => window.archMap.setFocus(id), block);
    await sleep(2500);
    await round('inside a block');
    await page.evaluate(() => window.archMap.setFocus(null));
    await sleep(2000);
    const sc = await page.evaluate(() => window.archMap.scenarios[0]?.id ?? null);
    if (sc) {
        await page.evaluate((id) => window.archMap.scenario(id, 1), sc);
        await sleep(1500);
        await round('scenario open');
        await page.evaluate(() => (mapRoot().activeElement as HTMLElement | null)?.blur()); // the «?» button had the focus back
        await page.keyboard.press(' '); // Space: the cinema
        await sleep(1500);
        assert.ok((await where(page)).cinema, 'Space did not start the cinema');
        await round('cinema');
        await page.keyboard.press('Escape');
        await sleep(1200);
    }
    // in the search box `?` is a character
    await page.click('#q');
    await page.keyboard.type('a?');
    const typed = { value: await page.inputValue('#q'), open: await sheetOpen(page) };
    measure(t, { states: Object.keys(seen), seen, typed });
    assert.deepEqual(typed, { value: 'a?', open: false });
    assert.deepEqual(errors, []);
    await page.close();
});

test('the open sheet keeps the keyboard and the pointer: Tab, Shift+Tab, Enter and clicks never reach the page behind', async (t) => {
    const { page, errors } = await open(browser);
    await page.setViewportSize(FOLD);
    const sc = await page.evaluate(() => window.archMap.scenarios[0]?.id ?? null);
    assert.ok(sc, 'the default project has no scenario');
    await page.evaluate((id) => window.archMap.scenario(id, 2), sc);
    await sleep(1500);
    const step = () => page.evaluate(() => (window.archMap.state as unknown as { scenario: { i: number } | null }).scenario?.i ?? null);
    const inSheet = () => page.evaluate(() => !!mapRoot().activeElement?.closest('#helpsheet'));
    const i0 = await step();
    await page.keyboard.press('?');
    const kept: boolean[] = []; // the focus is in the sheet after each key
    for (const key of ['Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
        await page.keyboard.press(key);
        kept.push(await inSheet());
        await page.keyboard.press('Enter'); // on the sheet's ✕: closes it — reopened at once
        if (!(await sheetOpen(page))) await page.keyboard.press('?');
    }
    // a click on a step button of the panel behind: it closes the sheet (outside its box) but does not reach the page
    const target = await page.evaluate(() => {
        const b = [...mapRoot().querySelectorAll<HTMLElement>('#panel [data-goto], #stepbar [data-scstep]')].map((x) => x.getBoundingClientRect()).find((r) => r.width && r.height);
        return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
    });
    assert.ok(target, 'no step button behind the sheet');
    await page.mouse.click(target.x, target.y);
    await sleep(300);
    const i1 = await step();
    measure(t, { i0, i1, kept, open: await sheetOpen(page) });
    assert.deepEqual(kept, kept.map(() => true), 'the focus left the sheet');
    assert.equal(i1, i0, 'a key or a click under the sheet changed the scenario step');
    assert.deepEqual(errors, []);
    await page.close();
});

test('the Scenarios menu says how to play one (Space: cinema)', async () => {
    const { page, errors } = await open(browser);
    if (await page.isVisible('#scbtn')) {
        await page.click('#scbtn');
        const hint = await page.textContent('#scmenu .sc-hint');
        assert.match(hint ?? '', /Space\s+cinema/);
    }
    assert.deepEqual(errors, []);
    await page.close();
});
