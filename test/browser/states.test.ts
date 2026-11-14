// Dead ends and keyboard/ARIA states of the toolbar: the error page for an unknown project or document (links into a
// working map, no dead controls), the search as a combobox driven by the keyboard alone (empty state, arrows, Enter on
// the active option, Esc), the Scenarios menu on a map without a scenario, aria-expanded on the menus, and the live
// regions (one status line, the panel and step bar are not live).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withMapRoot, open, BASE, VIEWPORT, DOCS, sleep, measure } from './lib.ts';
import type { Page } from 'playwright-core';

const browser = await launch();
after(() => browser.close());
const ready = (page: Page) => page.waitForFunction(() => window.archMap && performance.getEntriesByName('archMap:ready').length > 0, null, { timeout: 30000 });

async function errorPage(qs: string) {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await withMapRoot(page);
    await page.goto(BASE + '/' + qs);
    await page.waitForSelector('.notice');
    return page;
}

test('unknown project: links (each title once), no dead controls, a link opens a working map', async (t) => {
    const page = await errorPage('?project=nope');
    try {
        const links = await page.locator('.notice a').evaluateAll((as) => as.map((a) => ({ text: a.textContent, href: a.getAttribute('href') })));
        assert.ok(links.length >= 2, 'the known projects are links');
        assert.ok(links.every((l) => l.href?.startsWith('?project=') && !/ — /.test(l.text ?? '')), 'title once, no "name — title"');
        for (const sel of ['#scbtn', '#viewbtn', '#q']) assert.equal(await page.locator(sel).isVisible(), false, sel + ' is hidden on the error page');
        const target = new URL(BASE + '/' + links[1].href).searchParams.get('project');
        await Promise.all([page.waitForURL((u) => u.search === '?project=' + target), page.click('.notice a >> nth=1')]);
        await ready(page);
        assert.equal(await page.evaluate(() => window.archMap.project), target);
        assert.equal(await page.locator('.notice').count(), 0);
        assert.equal(await page.locator('#viewbtn').isVisible(), true);
        measure(t, { links });
    } finally { await page.close(); }
});

test('missing document: the same error page with project links', async () => {
    const page = await errorPage('?docs=missing.json');
    try {
        assert.ok(await page.locator('.notice a').count() >= 2);
        assert.equal(await page.locator('#scbtn').isVisible(), false);
        assert.match(await page.locator('.notice').innerText(), /missing\.json/);
        await Promise.all([page.waitForURL((u) => u.search.startsWith('?project=')), page.click('.notice a >> nth=0')]);
        await ready(page);
    } finally { await page.close(); }
});

test('search is a combobox: empty state, arrows, Enter opens the active option, Esc closes', async (t) => {
    const { page, errors } = await open(browser, DOCS.tasks);
    try {
        const q = page.locator('#q');
        assert.equal(await q.getAttribute('role'), 'combobox');
        assert.equal(await q.getAttribute('aria-expanded'), 'false');
        await q.click();
        await page.keyboard.type('zzzzqq');
        assert.equal(await q.getAttribute('aria-expanded'), 'true');
        const empty = await page.locator('#results').innerText();
        assert.match(empty, /No matches for “zzzzqq”/);
        assert.match(empty, /titles, endpoint routes and table/);
        await page.keyboard.press('Escape');
        assert.equal(await q.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.evaluate(() => mapRoot().activeElement?.id), 'q', 'Esc closes the list and keeps the focus in the box');
        // a real query with several hits
        await q.fill('');
        await page.keyboard.type('task');
        const options = await page.locator('#results [role=option]').count();
        assert.ok(options >= 3, `${options} options`);
        assert.equal(await q.getAttribute('aria-activedescendant'), null);
        await page.keyboard.press('ArrowDown');
        assert.equal(await q.getAttribute('aria-activedescendant'), 'res-0');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        const id = await q.getAttribute('aria-activedescendant');
        assert.equal(id, 'res-2');
        assert.equal(await page.locator('#res-2').getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('#res-0').getAttribute('aria-selected'), 'false');
        await page.keyboard.press('ArrowUp');
        assert.equal(await q.getAttribute('aria-activedescendant'), 'res-1');
        const second = await page.locator('#res-1 b').innerText();
        const secondIsPath = (await page.locator('#res-1 span').innerText()).endsWith('· path');
        const hash0 = page.url();
        await page.keyboard.press('Enter');
        await sleep(1800);
        assert.equal(await q.getAttribute('aria-expanded'), 'false');
        const shown = await page.evaluate(() => ({ sel: window.archMap.state.selected, focus: window.archMap.state.focus, hasPath: !!window.archMap.state.path, title: mapRoot().querySelector('#panel h3, #panel h2')?.textContent ?? '' }));
        assert.ok(shown.hasPath || shown.sel || shown.focus, 'the active option (not the first) was opened');
        if (!secondIsPath) assert.equal(shown.title, second, 'the panel shows the second option, not the first');
        measure(t, { options, second, secondIsPath, shown, url: [hash0, page.url()], errors });
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('Scenarios menu: no scenarios says so, aria-expanded follows the menus, one live status line', async (t) => {
    const lib = await open(browser, DOCS.library);
    try {
        const { page } = lib;
        const btn = page.locator('#scbtn');
        assert.equal(await btn.isVisible(), true, 'the button stays on a map without a scenario');
        assert.equal(await btn.getAttribute('aria-expanded'), 'false');
        await btn.click();
        assert.equal(await btn.getAttribute('aria-expanded'), 'true');
        assert.match(await page.locator('#scmenu').innerText(), /No scenarios in this project/);
        assert.match(await page.locator('#scmenu').innerText(), /specs\/README\.md/);
        await page.keyboard.press('Escape');
        assert.equal(await btn.getAttribute('aria-expanded'), 'false');
        const view = page.locator('#viewbtn');
        assert.equal(await view.getAttribute('aria-expanded'), 'false');
        await view.click();
        assert.equal(await view.getAttribute('aria-expanded'), 'true');
        await page.mouse.click(300, 600);
        assert.equal(await view.getAttribute('aria-expanded'), 'false');
        // live regions: only #sr-status
        assert.deepEqual(await page.locator('[aria-live], [role=status]').evaluateAll((els) => els.map((e) => e.id).sort()), ['sr-status', 'toast', 'zoomhint']);
        assert.equal(await page.locator('#panel').getAttribute('aria-live'), null);
        await page.evaluate(() => { const a = window.archMap; a.setFocus(null); });
        const id = await page.evaluate(() => [...window.archMap.model.nodes.values()].find((n) => !n.parent)!.id);
        const at = await page.evaluate((i) => window.archMap.scene.screenCenter(i), id);
        await page.mouse.click(at!.x, at!.y);
        await sleep(300);
        const status = await page.locator('#sr-status').textContent();
        assert.ok(status && status.length < 80, `status line: ${status}`);
        measure(t, { status });
    } finally { await lib.page.close(); }

    const { page } = await open(browser, DOCS.tasks);
    try {
        await page.click('#scbtn');
        assert.equal(await page.locator('#scbtn').getAttribute('aria-expanded'), 'true');
        assert.ok(await page.locator('#scmenu .sc-item').count() >= 1);
        await page.click('#scmenu .sc-item >> nth=0');
        await sleep(600);
        assert.equal(await page.locator('#stepbar').getAttribute('aria-live'), null, 'the step bar is not a live region');
        const first = await page.locator('#sr-status').textContent();
        assert.match(first ?? '', /^Step 1 of \d+: /);
        await page.keyboard.press('ArrowRight');
        await sleep(600);
        const second = await page.locator('#sr-status').textContent();
        assert.match(second ?? '', /^Step 2 of \d+: /);
        measure(t, { first, second });
    } finally { await page.close(); }
});

test('search keyboard: ArrowUp from nothing active, and a refined query forgets the active option', async (t) => {
    const { page, errors } = await open(browser, DOCS.tasks);
    try {
        const q = page.locator('#q');
        const active = () => q.getAttribute('aria-activedescendant');
        const count = () => page.locator('#results [role=option]:not(.res-empty)').count();
        await q.click();
        await page.keyboard.type('task');
        const many = await count();
        assert.ok(many >= 3, `${many} options`);
        await page.keyboard.press('ArrowUp');
        assert.equal(await active(), `res-${many - 1}`, 'ArrowUp from nothing active goes to the last option');
        // refine: the old active option is gone; Enter opens the first hit of the new list, nothing throws
        await q.fill('');
        await page.keyboard.type('task');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
        assert.equal(await active(), 'res-2');
        await page.keyboard.type('s');
        assert.equal(await active(), null, 'a new query resets aria-activedescendant');
        assert.equal(await page.locator('#results [aria-selected=true]').count(), 0);
        // exactly one hit (the longest node titles are the most specific): ArrowUp from nothing active lands on it
        const titles = await page.evaluate(() => [...window.archMap.model.nodes.values()].map((n) => (n as unknown as { title: string }).title).sort((x, y) => y.length - x.length).slice(0, 12));
        let one = 0, single = '';
        for (const title of titles) {
            await q.fill('');
            await page.keyboard.type(title);
            if ((one = await count()) === 1) { single = title; break; }
        }
        measure(t, { many, one, single });
        assert.equal(one, 1, 'a query with exactly one hit was found');
        await page.keyboard.press('ArrowUp');
        assert.equal(await active(), 'res-0');
        // fewer hits after the active moved, then Enter
        await q.fill('');
        await page.keyboard.type('task');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
        await page.keyboard.type('_comment');
        await page.keyboard.press('Enter');
        // zero hits after the active moved, then Enter: nothing opens, nothing throws
        await q.fill('');
        await page.keyboard.type('task');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
        await page.keyboard.type('zzzz');
        assert.equal(await active(), null);
        const before = page.url();
        await page.keyboard.press('Enter');
        await sleep(300);
        assert.equal(page.url(), before);
        assert.equal(await q.getAttribute('aria-expanded'), 'true', 'the empty-state row stays');
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});
