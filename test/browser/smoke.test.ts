// The final smoke run: search, Path from the search box, fps while the wheel works, a scenario and cinema on
// the task workspace, including all five summary steps, with 0 console errors everywhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import { launch, open, within, measure, sleep, DOCS } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

test('search and Path: tasks, /task-summary → POST /task-summary', async (t) => {
    const { page, errors } = await open(browser);
    try {
        await page.fill('#q', 'tasks');
        await sleep(300);
        const taskResults = await page.$$eval('#results li', (l) => l.length);
        await page.fill('#q', '/task-summary');
        await sleep(300);
        const summaryResults = await page.$$eval('#results li', (l) => l.length);
        await page.press('#q', 'Enter');
        await sleep(2500);
        const path = await page.evaluate(() => {
            const a = window.archMap;
            return { title: a.state.path?.title ?? null, steps: a.state.path?.steps.length ?? 0, callers: a.state.path?.callers.length ?? 0, bar: mapRoot().querySelector('#focusbar')?.textContent?.replace(/\s+/g, ' ').trim() ?? '' };
        });
        measure(t, { taskResults, summaryResults, path });
        within(taskResults, 13, 15, 'results for tasks');
        within(summaryResults, 2, 4, 'results for /task-summary');
        assert.equal(path.title, 'POST /task-summary');
        assert.equal(path.callers, 1);
        within(path.steps, 7, 9, 'Path steps of POST /task-summary', path);
        assert.match(path.bar, /Path/);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('fps while the wheel works ≥ 30', async (t) => {
    const { page, errors } = await open(browser);
    try {
        await page.mouse.move(800, 500);
        const f0 = await page.evaluate(() => window.archMap.frames);
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
            const k = Math.floor((Date.now() - t0) / 750) % 2;
            await page.mouse.wheel(0, k ? 40 : -40);
            await sleep(30);
        }
        const f1 = await page.evaluate(() => window.archMap.frames);
        const fps = (f1 - f0) / ((Date.now() - t0) / 1000);
        measure(t, { fps: +fps.toFixed(1) });
        assert.ok(fps >= 30, `fps ${fps.toFixed(1)} under the wheel`);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('scenario and cinema on tasks-supabase: every step resolves, cinema plays every step and exits', async (t) => {
    const { page, errors } = await open(browser, DOCS.tasks);
    try {
        const sc = await page.evaluate(async () => {
            const a = window.archMap;
            const s = a.scenarios[0];
            const per: { step: number; of: number; caption: string }[] = [];
            for (let i = 1; i <= s.steps.length; i++) {
                const r = a.scenario(s.id, i);
                if (r) per.push({ step: r.step, of: r.of, caption: r.caption });
                await new Promise((done) => setTimeout(done, 300));
            }
            a.scenario();
            return { id: s.id, steps: s.steps.length, per };
        });
        assert.equal(sc.id, 'tasks.scenario.summary');
        assert.equal(sc.steps, 5);
        assert.equal(sc.per.length, sc.steps, 'a step did not resolve');
        assert.ok(sc.per.every((p, i) => p.step === i + 1 && p.of === sc.steps && p.caption.length > 0), JSON.stringify(sc.per));

        await page.evaluate((id) => window.archMap.scenario(id, 1), sc.id);
        await sleep(800);
        await page.evaluate(() => window.archMap.cinema.enter(0));
        await sleep(900);
        const entered = await page.evaluate(() => window.archMap.cinema.state);
        const phases: { phase: string; step: number | null }[] = [];
        for (let i = 0; i < sc.steps; i++) {
            await page.evaluate((k) => window.archMap.cinema.go(k), i);
            await sleep(1500);
            phases.push(await page.evaluate(() => { const s = window.archMap.cinema.state; return { phase: s.phase, step: s.step }; }));
        }
        await page.evaluate(() => window.archMap.cinema.exit());
        await sleep(800);
        const exited = await page.evaluate(() => window.archMap.cinema.state);
        measure(t, { steps: sc.steps, entered, phases: phases.map((p) => `${p.phase}:${p.step}`).join(' '), exited });
        assert.equal(entered.on, true);
        assert.equal(entered.phase, 'title');
        assert.deepEqual(phases.map((p) => p.step), sc.per.map((p) => p.step));
        assert.ok(phases.every((p) => p.phase === 'step'), JSON.stringify(phases));
        assert.equal(exited.on, false);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});
