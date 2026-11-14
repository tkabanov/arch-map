// The map as a package on a page that is not ours (test/browser/embed.html): the built @arch-map/viewer
// (`npm run lib:build`, run here first) loaded as one script (the IIFE, three bundled) and, for the custom element, as ES
// modules with three from an import map. A small server of its own serves the page, the package's dist/ and the
// published specs, so every request is seen. Checked with real input: two maps side by side (two demo projects, two
// themes) keep their own focus, selection and keys; the host page's styles, URL and history are untouched; destroy
// leaves the element empty and no window/document listener, animation frame or WebGL context behind, ten times over;
// a bad spec shows the notice in its element only; a container with no size draws once it gets one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, NOTCH_MS, measure } from './lib.ts';
import { root, requests, startEmbed, stopEmbed, openEmbed, pageListeners, twoProjects, mountMap, blockOf, state, type Handle } from './embed-fixture.ts';

before(startEmbed);
after(stopEmbed);

test('two maps on a host page: their own focus, selection, keys and theme; the page untouched; no request beyond the specs', async () => {
    const [p1, p2] = twoProjects();
    const { page, errors } = await openEmbed();
    try {
        const pageStyle = () => page.evaluate(() => {
            const cs = (sel: string) => { const s = getComputedStyle(document.querySelector(sel)!); return [s.color, s.fontFamily, s.borderTopStyle, s.backgroundColor].join(' | '); };
            return { body: cs('body'), panel: cs('#panel'), button: cs('#pagebtn'), html: document.documentElement.getAttribute('style') ?? '', theme: document.documentElement.dataset.theme ?? null, bodyClass: document.body.className, hash: location.hash, history: history.length, title: document.title };
        });
        const style0 = await pageStyle();
        requests.length = 0;
        assert.equal(await mountMap(page, 'a', '#a', { specsUrl: p1.urls }), 'ready');
        assert.equal(await mountMap(page, 'b', '#b', { fetchSpecs: p2.urls, contractsBase: `/specs/${p2.name}/`, theme: 'light' }), 'ready');
        await sleep(2500);
        assert.deepEqual(await pageStyle(), style0, 'the host page looks as it did (styles, <html>, <body>, hash, history, title)');
        const hosts = await page.evaluate(() => ['#a', '#b'].map((s) => document.querySelector<HTMLElement>(s)!.dataset.theme));
        assert.deepEqual(hosts, ['dark', 'light'], 'each host has its own theme');
        // the page's CSS does not reach into the maps: their #panel keeps the map's look
        const inner = await page.evaluate(() => getComputedStyle(document.querySelector('#a')!.shadowRoot!.querySelector('#panel')!).borderTopStyle);
        assert.notEqual(inner, 'dotted');
        const outside = requests.filter((r) => !/^\/(specs|dist)\//.test(r) && r !== '/favicon.ico');
        assert.deepEqual(outside, [], 'no request beyond the package and the specs');

        // the wheel over map A goes into a block of A; B stays where it was
        const a0 = await state(page, 'a'), b0 = await state(page, 'b');
        const target = await blockOf(page, 'a');
        assert.ok(target, 'a block to zoom into on map A');
        await page.mouse.move(target.x, target.y);
        for (let i = 0; i < 30 && (await state(page, 'a')).focus === a0.focus; i++) {
            await page.mouse.wheel(0, -100);
            await sleep(NOTCH_MS);
        }
        await sleep(1200);
        const a1 = await state(page, 'a');
        assert.notEqual(a1.focus, a0.focus, 'the wheel went into a block of map A');
        assert.deepEqual(await state(page, 'b'), b0, 'map B did not move');
        // a click on a block of B selects it in B only
        const tb = await blockOf(page, 'b');
        assert.ok(tb, 'a block on map B');
        await page.mouse.move(tb.x, tb.y);
        await sleep(300);
        await page.mouse.click(tb.x, tb.y);
        await sleep(600);
        assert.equal((await state(page, 'b')).selected, tb.id, 'the click selected the block in map B');
        assert.deepEqual(await state(page, 'a'), a1, 'map A kept its focus and selection');
        // keys go to the map that has the focus: Esc in B steps back in B, not in A
        await page.keyboard.press('Escape');
        await sleep(600);
        assert.equal((await state(page, 'b')).selected, null, 'Esc in B cleared its selection');
        assert.equal((await state(page, 'a')).focus, a1.focus, 'Esc in B did not leave the block A is in');
        // the help sheet opens in the map under the pointer when nothing has the focus
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
        await page.mouse.move(target.x, target.y);
        await page.keyboard.press('?');
        await sleep(300);
        const sheets = await page.evaluate(() => ['#a', '#b'].map((s) => document.querySelector(s)!.shadowRoot!.querySelector<HTMLDialogElement>('#helpsheet')!.open));
        assert.deepEqual(sheets, [true, false], '? opened the sheet of the map under the pointer only');
        await page.keyboard.press('Escape');
        // the callbacks heard the changes
        const events = await page.evaluate(() => window.events);
        assert.ok(events.a.some((e) => (e as unknown[])[0] === 'focus' && (e as unknown[])[1] === a1.focus), 'onFocus of A');
        assert.ok(events.b.some((e) => (e as unknown[])[0] === 'select' && ((e as unknown[])[1] as { id?: string } | null)?.id === tb.id), 'onSelect of B');
        assert.deepEqual(await pageStyle(), style0, 'still: no hash, no history entry, no page style');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('destroy leaves the element empty and nothing behind; ten mounts and destroys do not grow the WebGL contexts', async (t) => {
    const [p1, p2] = twoProjects();
    const { page, errors, warnings } = await openEmbed();
    try {
        const cdp = await page.context().newCDPSession(page);
        const listeners0 = await pageListeners(cdp);
        const host0 = await page.evaluate(() => document.querySelector('#a')!.outerHTML);
        assert.equal(await mountMap(page, 'a', '#a', { specsUrl: p1.urls }), 'ready');
        await sleep(800);
        const live1 = await page.evaluate(() => window.gl.live);
        assert.equal(live1, 1, 'one WebGL context per map');
        assert.ok((await pageListeners(cdp)).length > listeners0.length, 'a mounted map listens on the page (keys, the pointer)');
        for (let i = 0; i < 10; i++) {
            await page.evaluate(() => (window.maps.a.destroy(), window.maps.a.destroy())); // twice: a no-op the second time
            assert.equal(await mountMap(page, 'a', '#a', { specsUrl: i % 2 ? p1.urls : p2.urls }), 'ready', `mount ${i + 2}`);
            await sleep(300);
        }
        const live = await page.evaluate(() => window.gl);
        measure(t, { live, listeners: (await pageListeners(cdp)).length });
        assert.equal(live.live, 1, `WebGL contexts alive after 11 mounts: ${live.live} (made ${live.made})`);
        await page.evaluate(() => window.maps.a.destroy());
        await sleep(300);
        assert.equal(await page.evaluate(() => window.gl.live), 0, 'no WebGL context left');
        assert.deepEqual(await pageListeners(cdp), listeners0, 'no window or document listener of the map remains');
        const host = await page.evaluate(() => ({ html: document.querySelector('#a')!.outerHTML, children: document.querySelector('#a')!.shadowRoot?.childNodes.length ?? 0 }));
        assert.equal(host.children, 0, 'the shadow root is empty');
        assert.equal(host.html, host0, 'the element is as the page gave it');
        const r0 = await page.evaluate(() => window.rafCalls);
        await sleep(600);
        assert.equal(await page.evaluate(() => window.rafCalls), r0, 'no animation frame runs after destroy');
        await sleep(1500); // the maps' timers (settle, hints) would fire here
        assert.ok(!warnings.some((w) => /too many active webgl/i.test(w)), 'Chromium never ran out of WebGL contexts');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('a bad spec shows the notice in its element only and calls onError; a hidden container draws once it gets a size', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed();
    try {
        const doc = await page.evaluate(async (u) => (await fetch(u)).json(), p1.urls[0]);
        const bad = await mountMap(page, 'c', '#c', { specs: [{ ...doc, schemaVersion: '2.0.0' }] });
        assert.match(bad, /^rejected: Incompatible spec version: 2\.0\.0/);
        const notice = await page.evaluate(() => document.querySelector('#c')!.shadowRoot!.querySelector('.notice')?.textContent ?? '');
        assert.match(notice, /Incompatible spec version/);
        assert.deepEqual(await page.evaluate(() => window.events.c), [['error', 'Incompatible spec version: 2.0.0 (expected 1.x)']]);
        assert.equal(await page.evaluate(() => document.querySelectorAll('.notice').length), 0, 'no notice on the page itself');
        const missing = await mountMap(page, 'm', '#c', { specsUrl: ['/specs/nope.json'] });
        assert.match(missing, /^rejected: Could not load the specs/);
        // a container with no size: nothing is drawn until it has one
        await page.evaluate((urls) => {
            window.maps.h?.destroy();
            const h = (window.maps.h = window.ArchMap.mount(document.querySelector<HTMLElement>('#hidden')!, { specsUrl: urls, debug: true }));
            (window as unknown as { hReady: boolean }).hReady = false;
            void h.ready.then(() => ((window as unknown as { hReady: boolean }).hReady = true));
        }, p1.urls);
        await sleep(1500);
        assert.equal(await page.evaluate(() => (window as unknown as { hReady: boolean }).hReady), false, 'not drawn while 0×0');
        await page.evaluate(() => Object.assign(document.querySelector<HTMLElement>('#hidden')!.style, { width: '600px', height: '400px' }));
        await page.waitForFunction(() => (window as unknown as { hReady: boolean }).hReady, null, { timeout: 15000 });
        await sleep(800);
        const canvas = await page.evaluate(() => {
            const c = document.querySelector('#hidden')!.shadowRoot!.querySelector('canvas')!;
            return { w: c.width, h: c.height, frames: window.maps.h.probe!.frames };
        });
        assert.ok(canvas.w > 0 && canvas.h > 0 && canvas.frames > 0, `drawn once sized: ${JSON.stringify(canvas)}`);
        // the missing document's 404 is the browser's own line for the request this check makes on purpose
        assert.deepEqual(errors.filter((e) => !/status of 404/.test(e)), []);
        assert.equal(errors.length, 1);
    } finally {
        await page.close();
    }
});

test('<arch-map> from the ES modules (three from the page): renders from src, theme by attribute, removed with the element', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed('/element.html');
    try {
        await page.waitForFunction(() => (window as unknown as { elementReady?: boolean }).elementReady);
        await page.evaluate((src) => {
            const el = document.querySelector('#el')!;
            (el as unknown as { options: Record<string, unknown> }).options = { debug: true }; // read at mount
            el.setAttribute('theme', 'light');
            el.setAttribute('src', src); // set after the element was connected: it mounts on the first src it gets
        }, p1.urls.join(','));
        await page.waitForFunction(() => document.querySelector('#el')!.shadowRoot?.querySelector('canvas'), null, { timeout: 15000 });
        await sleep(1500);
        const shown = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('#el')!;
            return { theme: el.dataset.theme, blocks: el.shadowRoot!.querySelectorAll('.nlabel').length, live: window.gl.live };
        });
        assert.equal(shown.theme, 'light');
        assert.ok(shown.blocks > 0, 'block names are drawn');
        assert.equal(shown.live, 1);
        // attributes changed after the mount: the theme flips on the host, another src draws the other project
        const [, p2] = twoProjects();
        const probeOf = () => page.evaluate(() => {
            const el = document.querySelector('#el') as unknown as { handle: Handle; dataset: DOMStringMap };
            return { theme: el.dataset.theme, project: (el.handle.probe as unknown as { project: string } | null)?.project ?? null };
        });
        const before2 = await probeOf();
        await page.evaluate(() => document.querySelector('#el')!.setAttribute('theme', 'dark'));
        await page.waitForFunction(() => (document.querySelector('#el') as HTMLElement).dataset.theme === 'dark');
        await page.evaluate((src) => document.querySelector('#el')!.setAttribute('src', src), p2.urls.join(','));
        await page.evaluate(() => (document.querySelector('#el') as unknown as { handle: Handle }).handle.ready);
        await sleep(800);
        const after2 = await probeOf();
        assert.equal(after2.theme, 'dark');
        if (p2.name !== p1.name) assert.notEqual(after2.project, before2.project, `the other project is drawn: ${JSON.stringify([before2, after2])}`);
        assert.equal(await page.evaluate(() => window.gl.live), 1, 'one context after the rebuilds');
        await page.evaluate(() => document.querySelector('#el')!.remove());
        await sleep(400);
        assert.equal(await page.evaluate(() => window.gl.live), 0, 'removing the element destroys the map');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('the handle: focus and select, setTheme keeps the place and flips the host, setSpecs draws the other project', async () => {
    const [p1, p2] = twoProjects();
    const { page, errors } = await openEmbed();
    try {
        assert.equal(await mountMap(page, 'a', '#a', { specsUrl: p1.urls }), 'ready');
        await sleep(1200);
        const target = await page.evaluate(() => {
            const a = window.maps.a.probe!;
            for (const n of a.model.nodes.values()) if (!n.parent && n.children.length) return { sys: n.id, child: (n.children[0] as { id: string }).id };
            return null;
        });
        assert.ok(target, 'a system with parts');
        await page.evaluate((t) => (window.maps.a.focus(t.sys), (window.maps.a as unknown as { select(id: string): void }).select(t.child)), target);
        await sleep(1500);
        const placed = await state(page, 'a');
        assert.equal(placed.selected, target.child, 'select took the block');
        assert.ok(placed.focus, 'focus went into the system');
        await page.evaluate(() => (window.maps.a as unknown as { setTheme(t: string): Promise<void> }).setTheme('light'));
        await sleep(1500);
        assert.equal(await page.evaluate(() => (document.querySelector('#a') as HTMLElement).dataset.theme), 'light');
        assert.deepEqual(await state(page, 'a'), placed, 'setTheme kept the focus and the selection');
        assert.equal(await page.evaluate(() => window.gl.live), 1);
        await page.evaluate((u) => (window.maps.a as unknown as { setSpecs(s: { specsUrl: string[] }): Promise<void> }).setSpecs({ specsUrl: u }), p2.urls);
        await sleep(1200);
        const other = await page.evaluate(() => (window.maps.a.probe as unknown as { project: string }).project);
        if (p2.name !== p1.name) assert.notEqual(other, p1.name, 'setSpecs drew the other project');
        assert.equal(await page.evaluate(() => window.gl.live), 1, 'one context after the rebuilds');
        // a second mount on the same element replaces the first: still one map, one context
        assert.equal(await mountMap(page, 'a2', '#a', { specsUrl: p1.urls }), 'ready');
        await sleep(500);
        assert.equal(await page.evaluate(() => window.gl.live), 1, 'mount over a live map destroyed it');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('contracts in an embed: fetched from the folder of specsUrl on first use; a custom loadContract is called instead', async (t) => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed();
    try {
        requests.length = 0;
        assert.equal(await mountMap(page, 'a', '#a', { specsUrl: p1.urls }), 'ready');
        await sleep(800);
        /** A block whose spec names a contract document: its details ask for it (and every contract document loads). */
        const withContract = (key: string) => page.evaluate((k) => {
            const a = window.maps[k].probe as unknown as { model: { merged: { elements: { id: string; contract?: { doc?: string } }[] }; nodes: Map<string, unknown>; nodeOf(id: string): string }; select(hit: { type: string; id: string }): void };
            // an endpoint's contract: its block's details list the endpoint with its request and response
            const el = a.model.merged.elements.find((e) => e.contract?.doc && a.model.nodes.has(a.model.nodeOf(e.id)));
            if (el) a.select({ type: 'node', id: a.model.nodeOf(el.id) });
            return el?.id ?? null;
        }, key);
        const scenario = await withContract('a');
        if (!scenario) return t.skip('the project has no block that names a contract');
        await sleep(1500);
        const fetched = requests.filter((r) => r.startsWith(`/specs/${p1.name}/`) && !p1.urls.includes(r));
        assert.ok(fetched.length > 0, `contracts fetched from the documents' folder: ${JSON.stringify(requests)}`);
        // a nested schema in the panel opens with a real click and is filled from the loaded contract
        const schema = await page.evaluate(() => {
            const d = document.querySelector('#a')!.shadowRoot!.querySelector('#panel details[data-schema]');
            d?.scrollIntoView();
            return !!d;
        });
        if (schema) {
            await page.locator('#a #panel details[data-schema] > summary').first().click();
            await page.waitForFunction(() => document.querySelector('#a')!.shadowRoot!.querySelector<HTMLElement>('#panel details[data-schema][data-filled]'), null, { timeout: 5000 });
        }
        measure(t, { contracts: fetched, schemaOpened: schema });
        // the same specs as objects with a loader of the page's own
        await page.evaluate(() => (window as unknown as { asked: string[] }).asked = []);
        assert.equal(await page.evaluate(async ({ urls, folder }) => {
            const specs = await Promise.all(urls.map(async (u) => ({ name: u.split('/').pop()!, doc: await (await fetch(u)).json() })));
            const asked = (window as unknown as { asked: string[] }).asked;
            const h = (window.maps.b = window.ArchMap.mount(document.querySelector<HTMLElement>('#b')!, { specs, debug: true, loadContract: (name: string) => (asked.push(name), fetch(folder + name).then((r) => r.json())) }));
            await h.ready;
            return 'ready';
        }, { urls: p1.urls, folder: `/specs/${p1.name}/` }), 'ready');
        await withContract('b');
        await sleep(1500);
        const asked = await page.evaluate(() => (window as unknown as { asked: string[] }).asked);
        assert.ok(asked.length > 0, 'loadContract was called');
        assert.deepEqual(asked.filter((n) => !fetched.some((f) => f.endsWith('/' + n))), [], 'it was asked for the same documents');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('the React wrapper (dist/react.js, React 18): renders, follows theme, an equal inline specs array is no rebuild, unmount leaves nothing', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed('/react.html');
    try {
        await page.waitForFunction(() => (window as unknown as { reactReady?: boolean }).reactReady);
        const render = (theme: string, className = 'map') => page.evaluate(({ urls, theme: th, cls }) => {
            const w = window as unknown as { React: { createElement: (...a: unknown[]) => unknown }; ReactDOM: { createRoot(el: Element): { render(x: unknown): void; unmount(): void } }; ArchMapReact: unknown; rr?: { render(x: unknown): void; unmount(): void }; builds: number };
            w.rr ??= w.ReactDOM.createRoot(document.querySelector('#root')!);
            w.builds ??= 0;
            // an inline array, a new one on every render
            w.rr.render(w.React.createElement(w.ArchMapReact, { specsUrl: [...urls], theme: th, className: cls, debug: true, onHandle: (h: { ready: Promise<void> } | null) => h && (window.maps.r = h as unknown as Handle) }));
        }, { urls: p1.urls, theme, cls: className });
        const host = () => page.evaluate(() => {
            const el = document.querySelector('#root > div > div') as HTMLElement | null;
            return { theme: el?.dataset.theme ?? null, children: el?.shadowRoot?.childNodes.length ?? 0, live: window.gl.live, made: window.gl.made };
        });
        await render('dark');
        await page.waitForFunction(() => window.maps.r);
        await page.evaluate(() => window.maps.r.ready);
        await sleep(800);
        const first = await host();
        assert.equal(first.theme, 'dark');
        assert.equal(first.live, 1);
        await render('dark'); // equal inline specs, equal theme: nothing is rebuilt
        await sleep(800);
        assert.equal((await host()).made, first.made, 'an equal inline array did not rebuild the map');
        await render('light');
        await page.waitForFunction(() => (document.querySelector('#root > div > div') as HTMLElement).dataset.theme === 'light');
        await page.evaluate(() => window.maps.r.ready);
        await sleep(500);
        const lit = await host();
        assert.equal(lit.made, first.made + 1, 'the theme change drew the map once more');
        assert.equal(lit.live, 1);
        // className is the wrapper's: a change leaves the classes the map sets on its own element (still, cinema)
        await page.evaluate(() => document.querySelector('#root > div > div')!.classList.add('still'));
        await render('light', 'map selected');
        await sleep(300);
        assert.deepEqual(await page.evaluate(() => [document.querySelector('#root > div')!.className, document.querySelector('#root > div > div')!.className]), ['map selected', 'still']);
        assert.equal((await host()).made, lit.made, 'a className change is no rebuild');
        await page.evaluate(() => {
            const w = window as unknown as { rr: { unmount(): void }; rdiv: Element | null };
            w.rdiv = document.querySelector('#root > div > div');
            w.rr.unmount();
        });
        await sleep(400);
        assert.equal(await page.evaluate(() => (window as unknown as { rdiv: Element }).rdiv.shadowRoot?.childNodes.length ?? 0), 0, 'the shadow root is empty');
        assert.equal(await page.evaluate(() => window.gl.live), 0, 'unmount destroyed the map');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('destroy or replacement during initial callbacks releases the abandoned scene', async () => {
    const doc = JSON.parse(readFileSync(join(root, 'test/fixtures/specs/sample-core.json'), 'utf8'));
    const { page, errors } = await openEmbed();
    try {
        await page.waitForFunction(() => window.ArchMap);
        const cdp = await page.context().newCDPSession(page);
        const listeners0 = await pageListeners(cdp);
        for (const replace of [false, true]) {
            const result = await page.evaluate(async ({ doc: specs, replace: again }) => {
                history.replaceState(null, '', '#f=app.api.payment.payment_module');
                const el = document.querySelector<HTMLElement>('#a')!;
                let replacement: Handle | undefined;
                let calls = 0, staleSelections = 0;
                const abandoned = window.ArchMap.mount(el, {
                    specs: [specs], urlState: true, debug: true, storageKey: false,
                    onSelect: () => staleSelections++,
                    onFocus: () => {
                        if (++calls !== 1) return;
                        if (again) replacement = window.ArchMap.mount(el, { specs: [specs], debug: true, storageKey: false });
                        else abandoned.destroy();
                    },
                });
                await abandoned.ready;
                await replacement?.ready;
                const probe = abandoned.probe;
                let survivor = true;
                if (replacement) {
                    replacement.focus('app.api.payment.payment_module');
                    survivor = !!replacement.probe?.state.focus && !!el.shadowRoot?.querySelector('canvas');
                }
                replacement?.destroy();
                abandoned.destroy();
                return { calls, staleSelections, survivor, probe: !!probe, children: el.shadowRoot!.childNodes.length };
            }, { doc, replace });
            assert.equal(result.calls, 1, 'initial focus called the consumer');
            assert.equal(result.staleSelections, 0, 'no selection callback after cancellation');
            assert.equal(result.survivor, true, 'the replacement stays rendered and accepts focus');
            assert.equal(result.probe, false, 'the abandoned handle owns no scene');
            assert.equal(result.children, 0);
            await page.waitForFunction(() => window.gl.live === 0);
            assert.deepEqual(await pageListeners(cdp), listeners0, 'callback teardown releases page listeners');
            const frames = await page.evaluate(() => window.rafCalls);
            await sleep(200);
            assert.equal(await page.evaluate(() => window.rafCalls), frames, 'no abandoned frame loop');
        }
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('destroy and replacement abort pending spec requests and settle their ready promises', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed();
    try {
        await page.route('**/pending-spec.json', () => {});
        for (const path of ['/pending-spec.json', '/pending-body.json']) for (const mode of ['destroy', 'mount', 'specs', 'theme']) {
            const requested = page.waitForRequest(`**${path}`);
            const headers = path.includes('body') ? page.waitForResponse(`**${path}`) : null;
            await page.evaluate((url) => {
                window.events.pending = [];
                window.maps.pending = window.ArchMap.mount(document.querySelector<HTMLElement>('#a')!, {
                    specsUrl: [url], onError: (e: unknown) => window.events.pending.push(e),
                });
            }, path);
            await requested;
            if (headers) await headers;
            const result = await page.evaluate(async ({ mode: how, urls }) => {
                const previous = window.maps.pending;
                const ready = previous.ready;
                if (how === 'mount') window.maps.next = window.ArchMap.mount(document.querySelector<HTMLElement>('#a')!, { specsUrl: urls });
                if (how === 'specs') void previous.setSpecs({ specsUrl: urls });
                if (how === 'theme') void previous.setTheme('light');
                if (how === 'destroy') previous.destroy();
                const settled = await Promise.race([ready.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))]);
                if (how === 'theme') previous.destroy();
                await previous.ready;
                previous.destroy();
                await window.maps.next?.ready;
                window.maps.next?.destroy();
                return { settled, errors: window.events.pending };
            }, { mode, urls: p1.urls });
            assert.equal(result.settled, true, 'aborted ready resolves promptly');
            assert.deepEqual(result.errors, [], 'cancellation is not a loading error');
        }
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('destroy restores pre-existing host presentation after rebuilds and errors', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed();
    try {
        const initial = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('#a')!;
            el.dataset.theme = 'brand';
            el.classList.add('cinema', 'still');
            for (const [key, value] of Object.entries({ '--accent': 'hotpink', '--font-ui': 'serif', '--sb-h': '7px', '--top-h': '8px', 'color-scheme': 'light' })) el.style.setProperty(key, value, 'important');
            return { theme: el.dataset.theme, classes: el.className, styles: [...el.style].map((key) => [key, el.style.getPropertyValue(key), el.style.getPropertyPriority(key)]).sort() };
        });
        assert.equal(await mountMap(page, 'a', '#a', { specsUrl: p1.urls }), 'ready');
        await page.evaluate(async () => {
            const h = window.maps.a as Handle & { setTheme(t: string): Promise<void> };
            await h.setTheme('light');
            await h.setTheme('dark');
            document.querySelector<HTMLElement>('#a')!.style.setProperty('border-radius', '9px');
        });
        assert.equal(await mountMap(page, 'successor', '#a', { specsUrl: p1.urls }), 'ready');
        await page.evaluate(() => window.maps.successor.destroy());
        const restored = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('#a')!;
            const radius = el.style.borderRadius;
            el.style.removeProperty('border-radius');
            return { radius, state: { theme: el.dataset.theme, classes: el.className, styles: [...el.style].map((key) => [key, el.style.getPropertyValue(key), el.style.getPropertyPriority(key)]).sort() } };
        });
        assert.equal(restored.radius, '9px', 'unrelated host changes survive');
        assert.deepEqual(restored.state, initial, 'original values and important priorities restored');
        assert.match(await mountMap(page, 'bad', '#a', { specs: [{ schemaVersion: '2.0.0' }] }), /^rejected:/);
        await page.evaluate(() => window.maps.bad.destroy());
        assert.deepEqual(await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('#a')!;
            return { theme: el.dataset.theme, classes: el.className, styles: [...el.style].map((key) => [key, el.style.getPropertyValue(key), el.style.getPropertyPriority(key)]).sort() };
        }), initial, 'error cleanup restores the same host state');
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('additional custom-element tags use distinct constructors and mount independently', async () => {
    const [p1] = twoProjects();
    const { page, errors } = await openEmbed('/element.html');
    try {
        await page.waitForFunction(() => (window as unknown as { elementReady?: boolean }).elementReady);
        const result = await page.evaluate(async (urls) => {
            const moduleUrl = '/dist/element.js';
            const { defineArchMap } = await import(moduleUrl);
            defineArchMap('other-map');
            defineArchMap('third-map');
            defineArchMap('other-map'); // idempotent registration
            const maps = ['arch-map', 'other-map', 'third-map'].map((tag) => {
                const el = document.createElement(tag) as HTMLElement & { handle: Handle; options: Record<string, unknown> };
                el.style.cssText = 'display:block;width:600px;height:400px';
                el.options = { debug: true, storageKey: false };
                el.setAttribute('src', urls.join(','));
                document.body.append(el);
                return el;
            });
            await Promise.all(maps.map((el) => el.handle.ready));
            const shown = maps.map((el) => !!el.handle.probe && !!el.shadowRoot?.querySelector('canvas'));
            const distinct = new Set(maps.map((el) => el.constructor)).size;
            for (const el of maps) el.remove();
            return { shown, distinct };
        }, p1.urls);
        assert.equal(result.distinct, 3);
        assert.deepEqual(result.shown, [true, true, true]);
        await page.waitForFunction(() => window.gl.live === 0);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test('React follows object spec contents without changing document identity or schema version', async () => {
    const doc = JSON.parse(readFileSync(join(root, 'test/fixtures/specs/sample-core.json'), 'utf8'));
    const { page, errors } = await openEmbed('/react.html');
    try {
        await page.waitForFunction(() => (window as unknown as { reactReady?: boolean }).reactReady);
        const render = (name: string) => page.evaluate(({ spec, name: next }) => {
            const w = window as unknown as { React: { createElement: (...a: unknown[]) => unknown; StrictMode: unknown }; ReactDOM: { createRoot(el: Element): { render(x: unknown): void; unmount(): void } }; ArchMapReact: unknown; rr?: { render(x: unknown): void; unmount(): void } };
            w.rr ??= w.ReactDOM.createRoot(document.querySelector('#root')!);
            spec.elements[0].name = next;
            w.rr.render(w.React.createElement(w.React.StrictMode, null, w.React.createElement(w.ArchMapReact, {
                specs: [{ name: 'sample-core.json', doc: spec }], debug: true, storageKey: false,
                onHandle: (h: Handle | null) => { if (h) window.maps.r = h; },
            })));
        }, { spec: doc, name });
        const label = () => page.evaluate(() => (window.maps.r.probe?.model.nodes.get('app.api') as unknown as { title?: string })?.title);
        await render('Initial architecture');
        await page.waitForFunction(() => window.maps.r?.probe);
        assert.equal(await label(), 'Initial architecture');
        const made = await page.evaluate(() => window.gl.made);
        await render('Updated architecture');
        await page.waitForFunction(() => (window.maps.r.probe?.model.nodes.get('app.api') as unknown as { title?: string })?.title === 'Updated architecture');
        assert.equal(await page.evaluate(() => window.gl.made), made + 1, 'edited document rebuilt once');
        assert.equal(await page.evaluate(() => window.gl.live), 1, 'StrictMode leaves one live scene');
        await render('Updated architecture');
        await sleep(200);
        assert.equal(await page.evaluate(() => window.gl.made), made + 1, 'equal document contents do not rebuild');
        await page.evaluate(() => (window as unknown as { rr: { unmount(): void } }).rr.unmount());
        await page.waitForFunction(() => window.gl.live === 0);
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

// A rebuild tells the page only a place that changed (setTheme keeps it: nothing, embed-host.test.ts); setSpecs puts the
// map back on the overview, so onFocus(null) and onSelect(null) come from the new build — and may destroy it or throw.
test('callbacks from a rebuild can destroy the map or throw without leaking a scene', async () => {
    const doc = JSON.parse(readFileSync(join(root, 'test/fixtures/specs/sample-core.json'), 'utf8'));
    const { page, errors } = await openEmbed();
    try {
        for (const event of ['focus', 'select']) for (const throws of [false, true]) {
            const result = await page.evaluate(async ({ spec, event: kind, throws: fails }) => {
                let armed = false, cancelled = false, stale = 0, reported = 0;
                const react = (what: string) => {
                    if (cancelled) stale++;
                    if (!armed || what !== kind) return;
                    armed = false;
                    if (fails) throw new Error('consumer restoration callback');
                    cancelled = true;
                    h.destroy();
                };
                const h = window.ArchMap.mount(document.querySelector<HTMLElement>('#a')!, {
                    specs: [spec], debug: true, storageKey: false, loadContract: () => Promise.resolve({}), // the panel of a selected block asks for contracts
                    onFocus: () => react('focus'), onSelect: () => react('select'), onError: () => reported++,
                });
                await h.ready;
                h.focus('app.api.payment.payment_module');
                (h as unknown as { select(id: string): void }).select('app.api.payment.payment_module.payment_controller');
                armed = true;
                const outcome = await h.setSpecs([spec]).then(() => 'resolved', () => 'rejected');
                const active = !!h.probe;
                h.destroy();
                return { outcome, active, stale, reported, armed };
            }, { spec: doc, event, throws });
            assert.equal(result.armed, false, 'the rebuild told the page the new place');
            assert.equal(result.outcome, throws ? 'rejected' : 'resolved');
            assert.equal(result.active, false, 'neither destroyed nor failed build retains a scene');
            assert.equal(result.stale, 0, 'callbacks stop with their build');
            assert.equal(result.reported, throws ? 1 : 0);
            await page.waitForFunction(() => window.gl.live === 0);
        }
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});
