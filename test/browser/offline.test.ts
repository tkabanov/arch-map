// Offline: the map needs nothing outside the machine. Every request that is not to the local server is
// aborted; nothing may try one, nothing may fail, fonts are the bundled IBM Plex, the map lays out and Path works.
// `npm run test:browser -- --build offline` runs it against the offline demo build (viewer:build + vite preview).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import { launch, withMapRoot, BASE, VIEWPORT, measure, sleep } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const local = (u: string) => {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
};

test(`offline: no request leaves the machine (${process.env.ARCH_MAP_BUILD ? 'preview build' : 'dev server'})`, async (t) => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await withMapRoot(page);
    const errors: string[] = [], blocked: string[] = [], failed: string[] = [];
    let requests = 0;
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('requestfailed', (r) => { if (local(r.url())) failed.push(r.url()); });
    await context.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith('data:') || u.startsWith('blob:') || local(u)) { requests++; return route.continue(); }
        blocked.push(u);
        return route.abort('internetdisconnected');
    });
    try {
        await page.goto(BASE + '/');
        await page.waitForFunction(() => window.archMap && performance.getEntriesByName('archMap:ready').length > 0, null, { timeout: 30000 });
        await sleep(2500);
        const fonts = await page.evaluate(async () => {
            await document.fonts.ready;
            return [...document.fonts].filter((f) => /plex/i.test(f.family) && f.status === 'loaded').length;
        });
        const blocks = await page.evaluate(() => window.archMap.state.placed.length);
        await page.fill('#q', '/task-summary');
        await sleep(300);
        await page.press('#q', 'Enter');
        await sleep(2500);
        const path = await page.evaluate(() => window.archMap.state.path?.steps.length ?? 0);
        measure(t, { requests, blocked, failed, fonts, blocks, pathSteps: path, errors: errors.length });
        assert.deepEqual(blocked, [], 'requests outside the machine');
        assert.deepEqual(failed, []);
        assert.ok(fonts >= 3, `${fonts} IBM Plex faces loaded`);
        assert.ok(blocks > 0, 'nothing placed');
        assert.ok(path > 0, 'no Path from the search box');
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
    }
});
