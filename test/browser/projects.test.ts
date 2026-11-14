// Real navigation between project maps, legacy document URLs, and project-scoped deep links/history.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, open, BASE, VIEWPORT, measure } from './lib.ts';
import type { Page } from 'playwright-core';
import type { ViewerManifest } from '../../types/project.ts';
import { shortTitles } from '../../viewer/src/projects.ts';

const browser = await launch();
after(() => browser.close());

async function ready(page: Page, project: string) {
    await page.waitForFunction((name) => window.archMap?.project === name && performance.getEntriesByName('archMap:ready').length > 0, project);
}
const snapshot = (page: Page) => page.evaluate(() => ({
    project: window.archMap.project,
    nodes: window.archMap.model.nodes.size,
    counts: window.archMap.counts(),
}));

test('project select: default, every manifest option, clean navigation and Back', async (t) => {
    const { page, errors } = await open(browser);
    try {
        const manifest = await (await page.request.get(BASE + '/specs/projects.json')).json() as ViewerManifest;
        assert.equal(manifest.default, 'tasks-supabase');
        assert.deepEqual(manifest.projects.map((p) => p.name), ['tasks-supabase', 'library-nest']);
        await ready(page, manifest.default);
        assert.equal(await page.locator('#project').isVisible(), true);
        assert.equal(await page.locator('#project').inputValue(), manifest.default);
        assert.deepEqual(await page.locator('#project option').evaluateAll((options) => options.map((o) => ({ name: (o as HTMLOptionElement).value, title: o.textContent }))), manifest.projects.map((p, i) => ({ name: p.name, title: shortTitles(manifest.projects)[i] })));
        const maps = [await snapshot(page)];
        for (const project of [...manifest.projects.slice(1), manifest.projects[0]]) {
            // Begin with an expert override and a hash: choosing a project must clear both.
            if (project === manifest.projects[1]) {
                await page.goto(BASE + '/?docs=' + manifest.projects[0].open.join(',') + '#v=tech');
                await ready(page, manifest.default);
            }
            await Promise.all([
                page.waitForURL((url) => url.search === '?project=' + project.name && url.hash === ''),
                page.selectOption('#project', project.name),
            ]);
            await ready(page, project.name);
            assert.equal(await page.title(), `${project.title} — Arch Map`);
            assert.equal(await page.locator('#project').inputValue(), project.name);
            const map = await snapshot(page);
            assert.ok(map.nodes > 0);
            assert.ok(map.counts.nodes > 0);
            maps.push(map);
        }
        const n = manifest.projects.length;
        assert.equal(new Set(maps.slice(0, n).map((m) => m.nodes)).size, n, 'each project loads a different model');
        assert.equal(maps[0].nodes, maps[n].nodes);
        const last = manifest.projects[n - 1].name;
        await page.goBack();
        await ready(page, last);
        assert.equal(new URL(page.url()).search, '?project=' + last);
        assert.equal(await page.locator('#project').inputValue(), last);
        assert.equal((await snapshot(page)).nodes, maps[n - 1].nodes);
        const back = await snapshot(page);
        for (const p of manifest.projects.slice(1, n - 1).reverse()) {
            await page.goBack();
            await ready(page, p.name);
        }
        await page.goBack();
        await ready(page, manifest.default);
        assert.equal(new URL(page.url()).searchParams.get('docs'), manifest.projects[0].open.join(','));
        assert.equal(new URL(page.url()).hash, '#v=tech');
        assert.equal(await page.locator('#project').inputValue(), manifest.default);
        assert.equal(await page.title(), `${manifest.projects[0].title} — Arch Map`);
        assert.equal((await snapshot(page)).nodes, maps[0].nodes);
        measure(t, { maps, back, restoredOverride: page.url(), errors });
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('project Path deep link and hash updates retain the query; legacy docs still resolves', async (t) => {
    const start = 'library.api.books.book_module.book_controller';
    const { page, errors } = await open(browser, '?project=library-nest#p=' + encodeURIComponent(start + '|*'));
    try {
        await ready(page, 'library-nest');
        const path = await page.evaluate(() => window.archMap.state.path);
        assert.ok(path && path.steps.length > 0);
        assert.match(await page.locator('#focusbar').innerText(), /Path/i);
        await page.locator('#focusbar [data-closepath]').click();
        assert.equal(new URL(page.url()).search, '?project=library-nest');
        assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).has('p'), false);
        await page.goto(BASE + '/?project=library-nest');
        await ready(page, 'library-nest');
        await page.locator('[data-view="tech"]').click();
        assert.equal(new URL(page.url()).search, '?project=library-nest');
        assert.equal(new URL(page.url()).hash, '#v=tech');
        await page.locator('[data-view="client"]').click();
        assert.equal(new URL(page.url()).search, '?project=library-nest');
        assert.equal(new URL(page.url()).hash, '');
        await page.goto(BASE + '/?docs=library-nest.json');
        await ready(page, 'library-nest');
        assert.equal(await page.locator('#project').inputValue(), 'library-nest');
        const legacy = await snapshot(page);
        // A node selection updates only s= via replaceState, preserving the expert query too.
        await page.evaluate(() => {
            const api = window.archMap as typeof window.archMap & { select(hit: { type: 'node'; id: string }): void };
            api.select({ type: 'node', id: 'library.db.loans' });
        });
        assert.equal(new URL(page.url()).search, '?docs=library-nest.json');
        assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('s'), 'library.db.loans');
        measure(t, { pathSteps: path.steps.length, legacy, errors });
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('a single-project manifest hides the switcher and retains the project title', async () => {
    const { page, errors } = await open(browser);
    try {
        await page.setViewportSize({ width: 390, height: 844 });
        const layout = await page.locator('#project').evaluate((select) => {
            const right = select.getBoundingClientRect().right;
            const scrollWidth = document.documentElement.scrollWidth;
            (select as HTMLSelectElement).hidden = true;
            const withoutSwitcher = document.documentElement.scrollWidth;
            (select as HTMLSelectElement).hidden = false;
            return { right, scrollWidth, withoutSwitcher, viewport: innerWidth };
        });
        assert.ok(layout.right <= layout.viewport, 'the project control fits a phone screen');
        assert.ok(layout.scrollWidth <= layout.withoutSwitcher, `the switcher does not add horizontal overflow: ${JSON.stringify(layout)}`);
        await page.setViewportSize(VIEWPORT);
        await page.route('**/specs/projects.json', async (route) => {
            const response = await route.fetch();
            const manifest = await response.json() as ViewerManifest;
            await route.fulfill({ json: { ...manifest, projects: manifest.projects.filter((p) => p.name === manifest.default) } });
        });
        await page.reload();
        await ready(page, 'tasks-supabase');
        assert.equal(await page.locator('#project').isVisible(), false);
        assert.equal(await page.locator('#project option').count(), 1);
        const manifest = await (await fetch(`${BASE}/specs/projects.json`)).json() as ViewerManifest;
        const only = manifest.projects.find((p) => p.name === manifest.default)!;
        assert.equal(await page.locator('#project option').textContent(), shortTitles([only])[0], 'the switcher keeps the short name');
        assert.equal(await page.title(), `${only.title} — Arch Map`, 'the page title keeps the long one');
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});
