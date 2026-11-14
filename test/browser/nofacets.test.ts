// `?nofacets=1`: the viewer drops every facet in spec-adapter.ts and must still work on the core
// alone — the browser half of `check:boundary`. Path has the same steps with and without facets, 0 facets are left.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, open, measure, sleep, DOCS } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

/** Elements and relations that still carry facets in the viewer's model. */
const facetCount = (page: Page) => page.evaluate(() => {
    const m = window.archMap.model as unknown as { nodes: Map<string, { facets?: object }>; edges: { facets?: object }[]; meta: { nofacets?: boolean } };
    const has = (x: { facets?: object }) => !!x.facets && Object.keys(x.facets).length > 0;
    return { nofacets: !!m.meta.nofacets, nodes: [...m.nodes.values()].filter(has).length, edges: m.edges.filter(has).length };
});

const pathOf = (page: Page) => page.evaluate(() => {
    const p = window.archMap.state.path;
    return p ? { title: p.title, steps: p.steps.length, callers: p.callers.length } : null;
});

/** [stack, docs query, how to open a Path: a search query (Enter) or [element id, method]] */
const CASES: [string, string, string | [string, string]][] = [
    ['tasks-supabase', DOCS.tasks, '/task-summary'],
    ['library-nest', DOCS.library, ['library.api.loans.loan_module.loan_controller', 'create']],
];

async function run(qs: string, how: string | [string, string]) {
    const { page, errors } = await open(browser, qs);
    try {
        const facets = await facetCount(page);
        if (typeof how === 'string') {
            await page.fill('#q', how);
            await sleep(300);
            await page.press('#q', 'Enter');
        } else {
            await page.evaluate(([id, m]) => (window.archMap as unknown as { startPath(id: string, m: string): void }).startPath(id, m), how);
        }
        await sleep(2500);
        const panel = await page.evaluate(() => mapRoot().querySelector('#panel')?.textContent ?? '');
        return { facets, path: await pathOf(page), errors, panel };
    } finally {
        await page.close();
    }
}

for (const [stack, qs, how] of CASES) {
    test(`?nofacets=1 on ${stack}: 0 facets, the same Path as with facets, 0 console errors`, async (t) => {
        const withF = await run(qs, how);
        const without = await run((qs ? qs + '&' : '?') + 'nofacets=1', how);
        measure(t, { with: { facets: withF.facets, path: withF.path }, without: { facets: without.facets, path: without.path } });
        assert.ok(withF.facets.nodes + withF.facets.edges > 0, 'the normal view has no facets: nothing is tested');
        assert.deepEqual(without.facets, { nofacets: true, nodes: 0, edges: 0 });
        assert.ok(withF.path && withF.path.steps > 0, 'no Path with facets');
        assert.deepEqual(without.path, withF.path);
        assert.deepEqual(withF.errors, []);
        assert.deepEqual(without.errors, []);
    });
}
