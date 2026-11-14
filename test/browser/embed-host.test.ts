// The built package on host pages that are not the site's (the package review of 2026-11-12): a strict
// Content-Security-Policy; a page that moves the map without a window scroll; a narrow map that scrolls inside its
// element; a host in a flex row; elements that cannot hold a map; the page's history.state; rebuilds and callbacks;
// Shift and Control held while the focus is outside the map. Real mouse and keyboard input (playwright-core).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sleep } from './lib.ts';
import { startEmbed, stopEmbed, openEmbed, twoProjects, mountMap, blockOf, state } from './embed-fixture.ts';
import type { Page } from 'playwright-core';

before(startEmbed);
after(stopEmbed);

/** The probe's parts these checks read beyond the fixture's `Probe`. */
const probeOf = (page: Page, key: string) => page.evaluate((k) => {
    const a = window.maps[k].probe as unknown as { state: { hover: { id?: string } | null }; scene: { controls: { getAzimuthalAngle(): number; target: { x: number; y: number; z: number }; _controlActive: boolean } } };
    const c = a.scene.controls;
    return { hover: a.state.hover?.id ?? null, azimuth: c.getAzimuthalAngle(), target: { ...c.target }, control: c._controlActive };
}, key);

test('a strict CSP (no unsafe-inline): no violation, the map drawn at its element\'s size, data-style applied', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed('/csp.html');
    try {
        assert.equal(await mountMap(page, 'c', '#m', { specsUrl: p1.urls }), 'ready');
        await sleep(1500);
        const r = await page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('#m')!, root = host.shadowRoot!;
            const canvas = root.querySelector('canvas')!;
            const dot = root.querySelector<HTMLElement>('.lg-kinds button');
            return {
                violations: (window as unknown as { violations: string[] }).violations,
                canvas: [canvas.clientWidth, canvas.clientHeight], host: [host.clientWidth, host.clientHeight],
                styles: root.adoptedStyleSheets.length, styleEls: root.querySelectorAll('style').length,
                left: root.querySelectorAll('[data-style]').length, dotColor: dot ? dot.style.getPropertyValue('--c') : null,
            };
        });
        assert.deepEqual(r.violations, [], 'no CSP violation');
        assert.ok(r.canvas[0] > 0 && r.canvas[0] <= r.host[0] && r.canvas[1] > 0 && r.canvas[1] <= r.host[1], `canvas ${r.canvas} within the host ${r.host}`);
        assert.equal(r.styles, 1, 'one adopted stylesheet');
        assert.equal(r.styleEls, 0, 'no <style> element');
        assert.equal(r.left, 0, 'every data-style applied');
        assert.ok(r.dotColor, 'a legend kind got its --c through the CSSOM');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('the page moves the map (content above grows) and scrolls the narrow map inside: hover still finds the block', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed('/layout.html');
    try {
        assert.equal(await mountMap(page, 'w', '#w', { specsUrl: p1.urls }), 'ready');
        await sleep(1500);
        const b = await blockOf(page, 'w');
        assert.ok(b, 'a block on the wide map');
        await page.mouse.move(b.x - 40, b.y - 40);
        await page.mouse.move(b.x, b.y, { steps: 4 });
        await sleep(400);
        assert.equal((await probeOf(page, 'w')).hover, b.id, 'hover before the page moved');
        await page.mouse.move(5, 5);
        await page.evaluate(() => (document.querySelector<HTMLElement>('#spacer')!.style.height = '90px'));
        await sleep(300);
        await page.mouse.move(b.x, b.y + 90 - 30);
        await page.mouse.move(b.x, b.y + 90, { steps: 4 });
        await sleep(400);
        assert.equal((await probeOf(page, 'w')).hover, b.id, 'hover where the block is now (90 px lower), no window scroll or resize');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('a narrow map in an element of a given height: the stage fits the host, "Details" scrolls only the map', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed('/layout.html');
    try {
        await page.evaluate(() => document.querySelector('#w')!.remove());
        assert.equal(await mountMap(page, 'n', '#n', { specsUrl: p1.urls }), 'ready');
        await sleep(1500);
        const box = await page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('#n')!, stage = host.shadowRoot!.querySelector<HTMLElement>('#stage')!;
            return { host: host.clientHeight, stage: stage.getBoundingClientRect().height, top: host.shadowRoot!.querySelector<HTMLElement>('.top')!.getBoundingClientRect().height };
        });
        assert.ok(box.stage <= box.host - box.top + 1, `the stage (${box.stage}) fits under the header in the host (${box.host})`);
        const b = await blockOf(page, 'n');
        assert.ok(b, 'a block on the narrow map');
        await page.mouse.move(b.x - 30, b.y - 30);
        await page.mouse.move(b.x, b.y, { steps: 4 });
        await sleep(600);
        const details = await page.evaluate(() => {
            const btn = document.querySelector('#n')!.shadowRoot!.querySelector<HTMLElement>('[data-select]');
            const r = btn?.getBoundingClientRect();
            return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        });
        assert.ok(details, 'the hover card shows "Details"');
        await page.mouse.move(details.x, details.y, { steps: 3 });
        await page.mouse.click(details.x, details.y);
        await sleep(1200);
        const scrolled = await page.evaluate(() => ({ page: window.scrollY, map: document.querySelector('#n')!.shadowRoot!.querySelector<HTMLElement>('.app')!.scrollTop }));
        assert.equal(scrolled.page, 0, 'the page did not scroll');
        assert.ok(scrolled.map > 0, `the map scrolled to its panel (${scrolled.map})`);
        assert.equal((await state(page, 'n')).selected, b.id);
        // the map scrolled inside: hover still finds a block where it now is
        const b2 = await blockOf(page, 'n');
        if (b2) {
            await page.mouse.move(b2.x - 30, b2.y - 30);
            await page.mouse.move(b2.x, b2.y, { steps: 4 });
            await sleep(400);
            assert.equal((await probeOf(page, 'n')).hover, b2.id, 'hover after the inner scroll');
        }
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('a host in a flex row draws (it had no width); an element that cannot hold a map is reported, not thrown', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed('/layout.html');
    try {
        await page.evaluate(() => ['#w', '#n'].forEach((s) => document.querySelector(s)!.remove()));
        const flex = await page.evaluate(async (urls) => {
            const h = window.ArchMap.mount(document.querySelector<HTMLElement>('#f')!, { specsUrl: urls });
            const won = await Promise.race([h.ready.then(() => 'ready'), new Promise((r) => setTimeout(() => r('pending'), 4000))]);
            const el = document.querySelector<HTMLElement>('#f')!;
            return { won, size: [el.clientWidth, el.clientHeight], canvas: !!el.shadowRoot?.querySelector('canvas') };
        }, p1.urls);
        assert.equal(flex.won, 'ready', 'the flex item drew');
        assert.ok(flex.size[0] > 0, `it has a width (${flex.size})`);
        assert.ok(flex.canvas);
        const bad = await page.evaluate(async (urls) => {
            const out: Record<string, unknown> = {};
            for (const [name, el] of [['figure', document.querySelector('#fig')], ['null', null]] as const) {
                const heard: string[] = [];
                try {
                    const h = window.ArchMap.mount(el as HTMLElement, { specsUrl: urls, onError: (e: { kind: string }) => heard.push(e.kind) } as Record<string, unknown>);
                    out[name] = await h.ready.then(() => 'resolved', (e: Error) => `rejected: ${e.message}`);
                } catch (e) {
                    out[name] = `threw: ${(e as Error).message}`;
                }
                out[`${name}:onError`] = heard;
            }
            return out;
        }, p1.urls);
        assert.match(String(bad.figure), /^rejected: .*<figure> cannot hold a shadow root/);
        assert.match(String(bad.null), /^rejected: .*needs an element, got null/);
        assert.deepEqual(bad['figure:onError'], ['map']);
        assert.deepEqual(bad['null:onError'], ['map']);
        assert.equal(errors.filter((e) => /@arch-map\/viewer: Could not show the map/.test(e)).length, 2, 'both told on the console');
        assert.equal(errors.length, 2);
    } finally {
        await page.close();
    }
});

test('Shift + drag rotates and Control is held, with the focus outside the map (keyboard: focus and page)', async () => {
    const [p1] = twoProjects();
    for (const keyboard of ['focus', 'page']) {
        const { page, errors } = await openEmbed('/layout.html');
        try {
            assert.equal(await mountMap(page, 'w', '#w', { specsUrl: p1.urls, keyboard }), 'ready');
            await sleep(1500);
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
            const box = await page.evaluate(() => document.querySelector('#w')!.shadowRoot!.querySelector('#stage')!.getBoundingClientRect().toJSON() as DOMRect);
            const x = box.left + box.width * 0.4, y = box.top + box.height * 0.3;
            const a0 = await probeOf(page, 'w');
            await page.mouse.move(x, y);
            await page.keyboard.down('Shift');
            await page.mouse.down();
            await page.mouse.move(x + 120, y, { steps: 12 });
            await page.mouse.up();
            await page.keyboard.up('Shift');
            await sleep(800);
            const a1 = await probeOf(page, 'w');
            assert.ok(Math.abs(a1.azimuth - a0.azimuth) > 0.2, `${keyboard}: Shift + drag rotated (Δ ${(a1.azimuth - a0.azimuth).toFixed(3)} rad)`);
            await page.keyboard.down('Control');
            assert.equal((await probeOf(page, 'w')).control, true, `${keyboard}: Control held is known with the focus on the page`);
            await page.keyboard.up('Control');
            assert.equal((await probeOf(page, 'w')).control, false);
            assert.deepEqual(errors, []);
        } finally {
            await page.close();
        }
    }
});

test('rebuilds: urlState keeps the page\'s history.state; setTheme twice keeps the place and tells the page nothing', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed('/layout.html');
    try {
        await page.evaluate(() => history.replaceState({ routerKey: 'abc', idx: 3 }, ''));
        assert.equal(await mountMap(page, 'w', '#w', { specsUrl: p1.urls, urlState: true }), 'ready');
        await sleep(1200);
        const t = await page.evaluate(() => {
            const a = window.maps.w.probe!;
            for (const n of a.model.nodes.values()) if (!n.parent && n.children.length) return { sys: n.id, child: (n.children[0] as { id: string }).id };
            return null;
        });
        assert.ok(t, 'a system with parts');
        await page.evaluate((x) => (window.maps.w.focus(x.sys), (window.maps.w as unknown as { select(id: string): void }).select(x.child)), t);
        await sleep(1200);
        assert.deepEqual(await page.evaluate(() => history.state), { routerKey: 'abc', idx: 3 }, 'history.state passed through');
        const placed = await state(page, 'w');
        const heard = await page.evaluate(() => window.events.w.length);
        await page.evaluate(async () => {
            const h = window.maps.w;
            void h.setTheme('light');
            await h.setTheme('dark');
        });
        await sleep(1200);
        assert.deepEqual(await state(page, 'w'), placed, 'a second setTheme before the first drew kept the focus and the selection');
        assert.equal(await page.evaluate(() => window.events.w.length), heard, 'no onFocus / onSelect for the same place');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});
