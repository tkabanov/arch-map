import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import { launch, open, sleep, DOCS, recordCinema, cinemaSeen, aim } from './lib.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

async function control(page: import('playwright-core').Page, selector: string) {
    await page.mouse.move(120, 180);
    await page.locator(selector).click();
}

// Open the authored scenario, then use its real Watch and playback controls throughout.
async function watch(page: import('playwright-core').Page) {
    await page.evaluate(() => window.archMap.scenario('tasks.scenario.summary', 1));
    await page.locator('[data-cinema]').first().click();
    await page.waitForFunction(() => window.archMap.cinema.state.phase === 'step');
}

test('uninterrupted cinema follows requests and reversed gateway returns, preserving pause position', { timeout: 120000 }, async () => {
    const { page, errors } = await open(browser, DOCS.tasks);
    try {
        await recordCinema(page);
        await watch(page);
        await page.waitForFunction(() => window.archMap.cinema.state.leg?.leg.contract?.request?.endsWith('/SummaryRequest'));
        assert.equal(await page.locator('.cn-contract .ct.request').count(), 1);
        assert.equal(await page.locator('.cn-contract .ct.response').count(), 0);
        assert.match(await page.locator('.cn-contract').innerText(), /SummaryRequest/);
        const sent = await page.evaluate(() => [...(window.archMap.scene.view.env?.values() ?? [])].flat());
        assert.ok(sent.length && sent.every((chip) => chip.side === 'request' && chip.env.key.endsWith('/SummaryRequest')));
        await page.waitForFunction(() => {
            const c = window.archMap.cinema.state;
            return c.leg?.leg.kind === 'response' && c.track && c.track.progress > 0.2 && c.track.progress < 0.6;
        }, null, { timeout: 60000 });
        const arriving = await page.evaluate(() => window.archMap.cinema.state);
        assert.ok(arriving.leg?.reverse);
        assert.match(await page.locator('.cn-contract').innerText(), /Return of control · payload unspecified/);
        assert.equal(await page.locator('.cn-contract .ct.request').count(), 0);
        assert.equal(await page.evaluate(() => window.archMap.scene.view.env?.size ?? 0), 0);
        assert.ok((arriving.track?.from ?? 0) > (arriving.track?.to ?? 1));
        await control(page, '[data-cplay]');
        const paused = await page.evaluate(() => ({ cinema: window.archMap.cinema.state, target: { ...window.archMap.scene.controls.target }, marker: window.archMap.scene.comet ? { ...window.archMap.scene.comet.mesh.position } : null }));
        await sleep(500);
        const held = await page.evaluate(() => ({ cinema: window.archMap.cinema.state, target: { ...window.archMap.scene.controls.target }, marker: window.archMap.scene.comet ? { ...window.archMap.scene.comet.mesh.position } : null }));
        assert.equal(held.cinema.elapsed, paused.cinema.elapsed);
        assert.ok(Math.hypot(held.target.x - paused.target.x, held.target.y - paused.target.y, held.target.z - paused.target.z) < 1e-8, 'paused camera stays in place');
        assert.ok(paused.marker);
        assert.deepEqual(held.marker, paused.marker);
        for (let repeat = 0; repeat < 2; repeat++) {
            await control(page, '[data-cplay]');
            await sleep(100);
            await control(page, '[data-cplay]');
        }
        const still = await page.evaluate(() => window.archMap.cinema.state);
        assert.equal(still.segment, paused.cinema.segment);
        assert.ok(still.elapsed > paused.cinema.elapsed);
        await control(page, '[data-cplay]');
        await page.waitForFunction(() => {
            const leg = window.archMap.cinema.state.leg?.leg;
            return leg?.kind === 'response' && leg.contract?.response?.endsWith('/SummaryResponse');
        });
        assert.equal(await page.locator('.cn-contract .ct.response').count(), 1);
        assert.equal(await page.locator('.cn-contract .ct.request').count(), 0);
        assert.match(await page.locator('.cn-contract').innerText(), /SummaryResponse/);
        const returnedChips = await page.evaluate(() => [...(window.archMap.scene.view.env?.values() ?? [])].flat());
        assert.ok(returnedChips.length && returnedChips.every((chip) => chip.side === 'response' && chip.env.key.endsWith('/SummaryResponse')));
        await page.waitForFunction(() => window.archMap.cinema.state.phase === 'end', null, { timeout: 90000 });
        const journey = await page.evaluate(() => window.archMap.cinema.state.journey!);
        const processed = journey.findIndex((leg) => leg.kind === 'processing' && leg.to === 'tasks.db.task.tasks');
        const returned = journey.findIndex((leg) => leg.kind === 'response' && leg.to === 'tasks.cand.api.tasks');
        const notified = journey.findIndex((leg) => leg.kind === 'processing' && leg.to === 'tasks.edge.task.task_notify.index');
        assert.ok(processed >= 0 && returned > notified && notified > processed, 'the server responds after database and notification processing');
        const seen = await cinemaSeen(page);
        const steps = [...new Set(seen.map((item) => Number(item.split(':')[0])))];
        assert.deepEqual(steps, [1, 2, 3, 4, 5]);
        const requests = new Set(seen.filter((item) => item.includes(':request:')).map((item) => item.split(':').at(-1)));
        for (const item of seen.filter((entry) => entry.includes(':response:'))) {
            const [from, to] = item.split(':').at(-1)!.split('>');
            if (from !== to) assert.ok(requests.has(`${to}>${from}`), `return retraces a forward hop: ${item}`);
        }
        const gateway = seen.filter((item) => item.includes(':response:') && item.includes('tasks.platform.gateway'));
        assert.ok(gateway.length >= 2, JSON.stringify(seen));
        assert.ok(seen.findIndex((item) => item.includes(':request:') && item.includes('tasks.platform.gateway')) < seen.findIndex((item) => item.includes(':response:') && item.includes('tasks.platform.gateway')));
        assert.equal(new Set(seen).size, seen.length, 'no hop replayed after repeated resume');
        await page.locator('[data-cinema="0"]').click();
        await page.waitForFunction(() => window.archMap.cinema.state.phase === 'title');
        await page.keyboard.press('Escape');
        await sleep(700);
        assert.equal(await page.evaluate(() => window.archMap.cinema.state.on), false);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('seek, restart and exit cancel old playback; reduced motion retains semantic progress', { timeout: 60000 }, async () => {
    const { page, errors } = await open(browser, DOCS.tasks);
    try {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.reload();
        await page.waitForFunction(() => window.archMap && performance.getEntriesByName('archMap:ready').length > 0);
        await page.evaluate(() => window.archMap.scenario('tasks.scenario.summary', 1));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('[data-cinema]').first().click();
        await sleep(900);
        assert.equal(await page.evaluate(() => window.archMap.cinema.state.playing), false);
        await control(page, '[data-cplay]');
        await page.waitForFunction(() => window.archMap.cinema.state.phase === 'step');
        await control(page, '[data-cstep="1"]');
        await page.waitForFunction(() => window.archMap.cinema.state.step === 2);
        await control(page, '[data-cplay]');
        await sleep(150);
        const paused = await page.evaluate(() => window.archMap.cinema.state);
        assert.equal(paused.track, null);
        assert.match(await page.locator('.cn-who').innerText(), /Request|Connection unspecified|Independent action/);
        await control(page, '[data-cstep="-1"]');
        await sleep(200);
        assert.equal(await page.evaluate(() => window.archMap.cinema.state.step), 1);
        await control(page, '[data-cexit]');
        await sleep(700);
        assert.equal(await page.evaluate(() => window.archMap.cinema.state.on), false);
        await sleep(2000);
        assert.equal(await page.evaluate(() => window.archMap.cinema.state.on), false);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('event subscribers stay visible as a fork and camera attention sends no response', { timeout: 60000 }, async () => {
    const { page, errors } = await open(browser, DOCS.library);
    try {
        // Extend only the test's document response with an authored scenario over existing extracted edges.
        await page.route('**/library-nest/library-nest.json', async (request) => {
            const response = await request.fetch();
            const doc = await response.json();
            doc.elements.push({ id: 'library.notifications', type: 'app', parent: null, name: 'Notification worker', tier: 'service', provenance: 'authored' });
            doc.elements.find((element: { id: string }) => element.id === 'library.api.notifications.notification_module').parent = 'library.notifications';
            doc.scenarios = [{ id: 'library.scenario.cinema', title: 'Loan event branches', steps: [
                { caption: 'Publish the loan event.', from: 'library.api.loans.loan_module.loan_service', to: 'library.api.bus.library_bus', channel: 'event' },
                { caption: 'Record an audit notice.', from: 'library.api.loans.loan_audit_module.loan_audit_service', to: 'library.db.notices', channel: 'write' },
                { caption: 'Notify the reader.', from: 'library.api.notifications.notification_module.notification_service', to: 'library.ext.email', channel: 'smtp' },
            ] }];
            await request.fulfill({ response, json: doc });
        });
        await page.reload();
        await page.waitForFunction(() => window.archMap?.scenarios.some((scenario) => scenario.id === 'library.scenario.cinema'));
        await page.evaluate(() => window.archMap.scenario('library.scenario.cinema', 1));
        await recordCinema(page);
        await page.locator('[data-cinema]').first().click();
        await page.waitForFunction(() => (window.archMap.cinema.state.leg?.frame?.length ?? 0) >= 3, null, { timeout: 20000 });
        const fork = await page.evaluate(() => {
            const c = window.archMap.cinema.state;
            return { frame: c.leg?.frame, visible: c.leg?.frame?.every((id) => window.archMap.state.placedIds.has(id)), track: c.track };
        });
        assert.equal(fork.visible, true);
        assert.equal(fork.track, null);
        await sleep(900);
        const readable = await page.evaluate((ids) => {
            const onScreen = (rect: DOMRect | undefined) => !!rect && rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
            return ids!.map((id) => {
                const el = mapRoot().querySelector<HTMLElement>(`.nlabel[data-id="${id}"]`);
                const rect = el?.querySelector('b')?.getBoundingClientRect();
                const title = window.archMap.model.nodes.get(id)!.title;
                const named = mapRoot().querySelector('.cn-who')?.textContent?.includes(title);
                const point = window.archMap.scene.screenCenter(id);
                const inFrame = !!point && point.x >= 0 && point.x <= innerWidth && point.y >= 0 && point.y <= innerHeight;
                return { id, inFrame, named, visible: named || (!!el && el.style.display !== 'none' && onScreen(rect)) };
            });
        }, fork.frame);
        await page.screenshot({ path: '/tmp/arch-map-cinema-event-fork.png' });
        assert.ok(readable.every((label) => label.visible && label.inFrame), JSON.stringify(readable));
        await page.waitForFunction(() => window.archMap.cinema.state.phase === 'end', null, { timeout: 45000 });
        const seen = await cinemaSeen(page);
        assert.equal(seen.filter((item) => item.includes(':delivery:library.api.bus.library_bus>')).length, 2, JSON.stringify(seen));
        assert.ok(seen.some((item) => item.includes(':attention:')));
        assert.ok(!seen.some((item) => item.includes(':response:') && item.includes('library.api.bus.library_bus')));
        await page.keyboard.press('Escape');
        await sleep(700);
        await page.locator('#stepbar [data-scdeep]').click();
        await page.evaluate(() => window.archMap.scenario('library.scenario.cinema', 1));
        await page.locator('[data-cinema]').first().click();
        await page.waitForFunction(() => (window.archMap.cinema.state.leg?.frame?.length ?? 0) >= 3);
        const collapsed = await page.evaluate(() => window.archMap.cinema.state.leg!);
        assert.equal(collapsed.from, collapsed.to, 'publication and topic collapse into the same app');
        assert.ok(new Set(collapsed.frame).size >= 2, 'collapsed publisher still shows a fork to visible subscribers');
        await page.keyboard.press('Escape');
        await sleep(700);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});


test('resuming finishes an unkeyed flight and re-resolves a paused request after real double-click expansion and wheel zoom', { timeout: 60000 }, async () => {
    const { page, errors } = await open(browser, DOCS.tasks);
    try {
        await page.evaluate(() => window.archMap.scenario('tasks.scenario.summary', 1));
        await page.locator('#stepbar [data-scdeep]').click();
        await page.locator('[data-cinema]').first().click();
        await page.waitForFunction(() => window.archMap.cinema.state.phase === 'step');
        await sleep(100);
        await page.keyboard.press('Space');
        const flight = await page.evaluate(() => {
            const a = window.archMap;
            const leg = a.cinema.state.leg!;
            return { target: { ...a.scene.controls.target }, expected: a.scene.shotOf(new Set([leg.to]), { pad: 2.6 })!.toT };
        });
        await page.keyboard.press('Space');
        await sleep(850);
        const arrived = await page.evaluate(() => ({ ...window.archMap.scene.controls.target }));
        assert.ok(Math.hypot(arrived.x - flight.expected.x, arrived.y - flight.expected.y, arrived.z - flight.expected.z) < 1e-5, 'unfinished framing completes after resume');
        assert.ok(Math.hypot(arrived.x - flight.target.x, arrived.y - flight.target.y, arrived.z - flight.target.z) > 0.01, 'resume does not leave the interrupted flight frozen');
        await control(page, '[data-cstep="1"]');
        await page.waitForFunction(() => Boolean(window.archMap.cinema.state.track));
        await page.keyboard.press('Space');
        const prior = await page.evaluate(() => window.archMap.cinema.state.leg!);
        const point = await aim(page, 'tasks.system.platform');
        assert.ok(point, 'platform is pickable during the paused request');
        await page.mouse.dblclick(point.x, point.y);
        await page.waitForFunction(() => window.archMap.state.focus === 'tasks.system.platform');
        await sleep(1000);
        await page.mouse.wheel(0, -100);
        await sleep(300);
        await page.keyboard.press('Space');
        const resumed = await page.evaluate(() => ({ leg: window.archMap.cinema.state.leg!, track: window.archMap.cinema.state.track }));
        assert.equal(resumed.leg.leg.edge?.id, prior.leg.edge?.id);
        assert.notEqual(resumed.leg.to, prior.to, 'paused semantic leg is resolved into the expanded platform');
        assert.ok(resumed.track, 'expanded request resumes a real curve');
        await page.keyboard.press('Escape');
        await sleep(700);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});
