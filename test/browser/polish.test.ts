// Stage 4 polish (P3-1, P3-2, P3-3, P3-5, P3-6) with real input in headless Chromium: the scenario's current step is
// scrolled into view in the panel (on every step change and after the cinema); the step bar leaves the legend alone;
// at 390×844 the header is compact and the step caption is on screen; no panel or control text is under 11 px; the
// layer names read at 4.5:1 or more; one «Leave ↑»; the project switcher shows the short name; the legend says in words
// which relations are off by default. Needs a project with a scenario (the demo `tasks-supabase`: ARCH_MAP_PROJECTS=examples).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { launch, withMapRoot, open, measure, sleep, BASE } from './lib.ts';
import { shortTitles } from '../../viewer/src/projects.ts';
import type { ViewerManifest } from '../../types/project.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

/** The first project that has a scenario, as `?project=`; null when none has (the checks are then skipped). */
async function withScenario(): Promise<string | null> {
    const m = (await (await fetch(BASE + '/specs/projects.json')).json()) as ViewerManifest;
    for (const p of [m.projects.find((x) => x.name === m.default)!, ...m.projects]) {
        const page = await browser.newPage();
        await withMapRoot(page);
        try {
            await page.goto(`${BASE}/?project=${p.name}`);
            await page.waitForFunction(() => window.archMap && performance.getEntriesByName('archMap:ready').length > 0, null, { timeout: 30000 });
            if (await page.evaluate(() => window.archMap.scenarios.length > 0)) return `?project=${p.name}`;
        } finally { await page.close(); }
    }
    return null;
}

const play = (page: Page, step: number) => page.evaluate((i) => { const a = window.archMap; a.scenario(a.scenarios[0].id, i); }, step);
/** Where the current step's row is against the panel's visible area. */
const stepInPanel = (page: Page) => page.evaluate(() => {
    const c = mapRoot().querySelector('#panel .sc-steps [aria-current]'), p = mapRoot().querySelector('#panel')!;
    if (!c) return null;
    const r = c.getBoundingClientRect(), b = p.getBoundingClientRect();
    return { top: Math.round(r.top - b.top), bottom: Math.round(b.bottom - r.bottom), scrolls: p.scrollHeight > p.clientHeight, scrollTop: p.scrollTop };
});

test('P3-1: the current step is scrolled into view in the panel, on every step change and after the cinema', async (t) => {
    const qs = await withScenario();
    if (!qs) return t.skip('no project with a scenario');
    const { page, errors } = await open(browser, qs);
    try {
        await page.setViewportSize({ width: 1440, height: 360 }); // short: the step list does not fit the panel
        await sleep(800);
        const seen: unknown[] = [];
        const n = await page.evaluate(() => window.archMap.scenarios[0].steps.length);
        for (const i of [0, n - 1, 1, n - 1]) {
            await play(page, i);
            await sleep(900);
            const at = await stepInPanel(page);
            seen.push({ step: i, ...at });
            assert.ok(at && at.top >= 0 && at.bottom >= 0, `step ${i + 1} is outside the panel: ${JSON.stringify(at)}`);
        }
        // the cinema on an early step, left on a late one
        await play(page, 0);
        await page.evaluate(() => window.archMap.cinema.enter(0));
        await sleep(1500);
        await page.evaluate((i) => window.archMap.cinema.go(i), n - 1);
        await sleep(1500);
        await page.keyboard.press('Escape');
        await sleep(1500);
        assert.equal(await page.evaluate(() => window.archMap.cinema.state.on), false, 'the cinema is still on');
        const left = await stepInPanel(page);
        seen.push({ afterCinema: left });
        assert.ok(left && left.top >= 0 && left.bottom >= 0, `after the cinema the current step is outside the panel: ${JSON.stringify(left)}`);
        measure(t, seen);
        assert.ok(seen.some((x) => (x as { scrollTop?: number }).scrollTop), 'the panel never scrolled: the check did not exercise the step list');
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('P3-1: the step bar does not cover the legend (1440×900), open or closed', async (t) => {
    const qs = await withScenario();
    if (!qs) return t.skip('no project with a scenario');
    const { page, errors } = await open(browser, qs);
    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await sleep(600);
        await play(page, 1);
        await sleep(900);
        const overlap = () => page.evaluate(() => {
            const a = mapRoot().querySelector('#stepbar')!.getBoundingClientRect(), l = mapRoot().querySelector('#legend')!.getBoundingClientRect();
            const w = Math.min(a.right, l.right) - Math.max(a.left, l.left), h = Math.min(a.bottom, l.bottom) - Math.max(a.top, l.top);
            return { w: Math.round(w), h: Math.round(h), legend: [l.left, l.top, l.right, l.bottom].map(Math.round), bar: [a.left, a.top, a.right, a.bottom].map(Math.round) };
        });
        const closed = await overlap();
        await page.click('#legend summary');
        await sleep(300);
        const opened = await overlap();
        measure(t, { closed, opened });
        for (const o of [closed, opened]) assert.ok(o.w <= 0 || o.h <= 0, `the step bar covers the legend: ${JSON.stringify(o)}`);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('P3-2: at 390×844 the header is at most 110 px and the step caption is on screen', async (t) => {
    const qs = await withScenario();
    if (!qs) return t.skip('no project with a scenario');
    const { page, errors } = await open(browser, qs);
    try {
        await page.setViewportSize({ width: 390, height: 844 });
        await sleep(800);
        const head = await page.evaluate(() => {
            const box = (s: string) => { const e = mapRoot().querySelector<HTMLElement>(s)!; const r = e.getBoundingClientRect(); return { visible: r.width > 0 && r.height > 0, inside: r.left >= 0 && r.right <= innerWidth }; };
            return { height: Math.round(mapRoot().querySelector('.top')!.getBoundingClientRect().height), search: box('#q'), project: box('#project'), scenarios: box('#scbtn'), view: box('#viewbtn'), help: box('#helpbtn'), wide: document.documentElement.scrollWidth };
        });
        assert.ok(head.height <= 110, `header ${head.height} px`);
        for (const k of ['search', 'project', 'scenarios', 'view', 'help'] as const) assert.deepEqual(head[k], { visible: true, inside: true }, k);
        assert.ok(head.wide <= 390, `horizontal overflow ${head.wide}`);
        const caps: unknown[] = [];
        const n = await page.evaluate(() => window.archMap.scenarios[0].steps.length);
        for (const i of [0, Math.floor(n / 2), n - 1]) {
            await play(page, i);
            await sleep(800);
            const c = await page.evaluate(() => {
                const cap = mapRoot().querySelector('.sb-cap')!.getBoundingClientRect(), bar = mapRoot().querySelector('#stepbar')!.getBoundingClientRect();
                return { capBottom: Math.round(cap.bottom), barBottom: Math.round(bar.bottom), vh: innerHeight, mapHeight: Math.round(mapRoot().querySelector('#stage')!.getBoundingClientRect().height) };
            });
            caps.push(c);
            assert.ok(c.capBottom <= c.vh && c.barBottom <= c.vh + 1, `the caption is clipped: ${JSON.stringify(c)}`);
            assert.ok(c.mapHeight >= 240, `the map is squeezed: ${JSON.stringify(c)}`);
        }
        measure(t, { head, caps });
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('P3-3: no panel or control text is under 11 px; the scale has five steps', async (t) => {
    const qs = await withScenario();
    if (!qs) return t.skip('no project with a scenario');
    const { page, errors } = await open(browser, qs);
    try {
        const scan = () => page.evaluate(() => {
            const small: string[] = [], sizes = new Set<number>();
            for (const el of mapRoot().querySelectorAll<HTMLElement>('*')) {
                if (el.closest('.labels, canvas, script, style, .sr-only')) continue; // the in-scene labels keep their own sizes
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
                const px = parseFloat(getComputedStyle(el).fontSize);
                sizes.add(px);
                if (px < 11) small.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').join('.') : ''} ${px}px "${el.textContent!.trim().slice(0, 24)}"`);
            }
            return { small, sizes: [...sizes].sort((a, b) => a - b) };
        });
        const states: Record<string, unknown> = {};
        states.overview = await scan();
        await page.click('#legend summary');
        await page.click('#viewbtn');
        states.menus = await scan();
        await page.click('#viewbtn');
        await play(page, 1);
        await sleep(900);
        states.scenario = await scan();
        const node = await page.evaluate(() => { const a = window.archMap; return [...a.model.nodes.keys()].find((id) => a.model.nodes.get(id)!.parent) ?? null; });
        if (node) { await page.evaluate((id) => window.archMap.setFocus(id), node); await sleep(1500); states.focus = await scan(); }
        measure(t, states);
        for (const [k, v] of Object.entries(states)) assert.deepEqual((v as { small: string[] }).small, [], `${k}: text under 11 px`);
        const all = new Set(Object.values(states).flatMap((v) => (v as { sizes: number[] }).sizes));
        // five UI steps (11, 12, 14, 16, 18); the cinema and the headings that use clamp() are not on screen here
        assert.ok(all.size <= 7, `too many text sizes in the panel and controls: ${[...all].join(', ')}`);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

/** A style rule for the map's own elements: into its shadow root (a page stylesheet does not reach them). */
const mapStyle = (page: Page, css: string) => page.evaluate((text) => {
    const s = document.createElement('style');
    s.textContent = text;
    mapRoot().appendChild(s);
}, css);

test('P3-5: the layer names read at 4.5:1 or more on the backdrop behind them (95th percentile pixel)', async (t) => {
    const { page, errors } = await open(browser);
    try {
        await mapStyle(page, '.labels, #focusbar, #legend, #card, #zoomhint { visibility: hidden !important; }');
        const rects = await page.evaluate(() => [...mapRoot().querySelectorAll('.layerlabel')].map((e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return { x: r.x, y: r.y, w: r.width, h: r.height, color: c.color, opacity: Number(c.opacity) }; }).filter((r) => r.w > 0 && r.x >= 0 && r.y >= 0));
        assert.ok(rects.length, 'no layer name on the first picture');
        await mapStyle(page, '.layerlabel { visibility: hidden !important; }');
        const shot = (await page.screenshot()).toString('base64');
        const worst = await page.evaluate(async ({ shot: png, rects: boxes }) => {
            const img = new Image();
            img.src = 'data:image/png;base64,' + png;
            await img.decode();
            const cv = document.createElement('canvas');
            cv.width = img.width; cv.height = img.height;
            const g = cv.getContext('2d')!;
            g.drawImage(img, 0, 0);
            const k = img.width / innerWidth;
            const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            const L = (r: number, gg: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
            let min = Infinity, at = '', minMax = Infinity;
            for (const r of boxes) {
                const m = r.color.match(/[\d.]+/g)!.map(Number);
                const px = g.getImageData(Math.round(r.x * k), Math.round(r.y * k), Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k))).data;
                const pix: [number, number, number][] = [];
                for (let i = 0; i < px.length; i += 4) pix.push([px[i], px[i + 1], px[i + 2]]);
                pix.sort((a, b) => L(...a) - L(...b));
                // the 95th percentile backdrop pixel (the odd bright line of a plate edge under a name is not the backdrop) and the very brightest
                for (const [which, bgc] of [['p95', pix[Math.floor(pix.length * 0.95)]], ['max', pix[pix.length - 1]]] as const) {
                    const bl = L(...bgc);
                    const fg = [0, 1, 2].map((c) => m[c] * r.opacity + bgc[c] * (1 - r.opacity));
                    const lf = L(fg[0], fg[1], fg[2]);
                    const ratio = (Math.max(lf, bl) + 0.05) / (Math.min(lf, bl) + 0.05);
                    if (which === 'p95' && ratio < min) { min = ratio; at = `${r.color} opacity ${r.opacity}`; }
                    if (which === 'max') minMax = Math.min(minMax, ratio);
                }
            }
            return { min, at, minMax };
        }, { shot, rects });
        measure(t, { labels: rects.length, worstRatioP95: Math.round(worst.min * 100) / 100, worstRatioBrightestPixel: Math.round(worst.minMax * 100) / 100, at: worst.at });
        assert.ok(worst.min >= 4.5, `layer name contrast ${worst.min.toFixed(2)}:1 (${worst.at})`);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('P3-6: one «Leave ↑», the short project name in the switcher, the legend says what is off by default', async (t) => {
    const qs = await withScenario();
    if (!qs) return t.skip('no project with a scenario');
    const m = (await (await fetch(BASE + '/specs/projects.json')).json()) as ViewerManifest;
    const { page, errors } = await open(browser, qs);
    try {
        const options = await page.locator('#project option').evaluateAll((o) => o.map((x) => ({ name: (x as HTMLOptionElement).value, text: x.textContent })));
        assert.deepEqual(options, m.projects.map((p, i) => ({ name: p.name, text: shortTitles(m.projects)[i] })));
        for (const o of options) assert.ok(!o.text!.includes(' — '), `the switcher shows the long title: ${o.text}`);
        // the legend: the kinds that are off by default say so in words, none is struck through
        await page.click('#legend summary');
        const kinds = await page.$$eval('#legend [data-kind]', (b) => b.map((x) => ({ kind: (x as HTMLElement).dataset.kind, on: x.getAttribute('aria-pressed'), text: x.textContent!.replace(/\s+/g, ' ').trim(), line: getComputedStyle(x).textDecorationLine })));
        const off = kinds.filter((k) => k.on === 'false');
        assert.ok(off.length, 'no relation kind is off by default');
        for (const k of off) { assert.match(k.text, /off by default/, k.text); assert.notEqual(k.line, 'line-through'); }
        for (const k of kinds.filter((x) => x.on === 'true')) assert.doesNotMatch(k.text, /off by default/);
        // the leave button of a focus and of a scenario's «go inside» carry one word
        const node = await page.evaluate(() => { const a = window.archMap; return [...a.model.nodes.keys()].find((id) => a.model.nodes.get(id)!.parent && a.model.nodes.get(id)!.parent !== null) ?? null; });
        await page.evaluate((id) => window.archMap.setFocus(id), node);
        await sleep(1500);
        const inFocus = await page.locator('#focusbar .fb-exit').allTextContents();
        await page.evaluate(() => window.archMap.setFocus(null));
        await play(page, 2);
        await sleep(1500);
        const inScenario = await page.locator('#focusbar .fb-exit').allTextContents();
        measure(t, { options, kinds, inFocus, inScenario });
        for (const text of [...inFocus, ...inScenario]) assert.ok(!/Step out/.test(text), text);
        assert.ok(inFocus.includes('Leave ↑'), `focus: ${inFocus}`);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('P3-1 (review): leaving the cinema with «Go inside» off still scrolls the current step into view', async (t) => {
    const qs = await withScenario();
    if (!qs) return t.skip('no project with a scenario');
    const { page, errors } = await open(browser, qs);
    try {
        await page.setViewportSize({ width: 1440, height: 360 });
        await sleep(800);
        await play(page, 0);
        await sleep(900);
        await page.click('#stepbar [data-scdeep]');
        assert.equal(await page.getAttribute('#stepbar [data-scdeep]', 'aria-pressed'), 'false', '«Go inside» is still on');
        await page.click('#stepbar .sb-watch');
        await sleep(1500);
        const n = await page.evaluate(() => window.archMap.scenarios[0].steps.length);
        await page.evaluate((i) => window.archMap.cinema.go(i), n - 1);
        await sleep(1500);
        await page.keyboard.press('Escape');
        await sleep(1500);
        assert.equal(await page.evaluate(() => window.archMap.cinema.state.on), false);
        const at = await stepInPanel(page);
        measure(t, at);
        assert.ok(at && at.scrolls && at.top >= 0 && at.bottom >= 0, `the current step is outside the panel: ${JSON.stringify(at)}`);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('P3-1 (review): an open legend stays inside the map and its summary reachable, at short and tall windows', async (t) => {
    const qs = await withScenario();
    if (!qs) return t.skip('no project with a scenario');
    const { page, errors } = await open(browser, qs);
    try {
        const seen: unknown[] = [];
        for (const height of [450, 600, 900]) {
            await page.setViewportSize({ width: 1440, height });
            await sleep(600);
            await play(page, 1);
            await sleep(900);
            if (!(await page.evaluate(() => (mapRoot().querySelector('#legend details') as HTMLDetailsElement).open))) await page.click('#legend summary');
            await sleep(300);
            const r = await page.evaluate(() => {
                const st = mapRoot().querySelector('#stage')!.getBoundingClientRect(), l = mapRoot().querySelector('#legend')!.getBoundingClientRect(), sm = mapRoot().querySelector('#legend summary')!.getBoundingClientRect(), bar = mapRoot().querySelector('#stepbar')!.getBoundingClientRect();
                return { height: innerHeight, stageTop: Math.round(st.top), legendTop: Math.round(l.top), legendBottom: Math.round(l.bottom), summaryTop: Math.round(sm.top), summaryBottom: Math.round(sm.bottom), barTop: Math.round(bar.top) };
            });
            seen.push(r);
            assert.ok(r.legendTop >= r.stageTop && r.summaryTop >= r.stageTop, `the legend leaves the map: ${JSON.stringify(r)}`);
            assert.ok(r.legendBottom <= r.barTop, `the legend is under the step bar: ${JSON.stringify(r)}`);
            // a real click on the summary closes it again
            await page.click('#legend summary');
            assert.equal(await page.evaluate(() => (mapRoot().querySelector('#legend details') as HTMLDetailsElement).open), false, `the summary does not close the legend at ${height}`);
        }
        measure(t, seen);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});

test('P3-6 (review): projects whose short titles collide keep distinguishable labels', async (t) => {
    const { page, errors } = await open(browser);
    try {
        const m = (await (await fetch(BASE + '/specs/projects.json')).json()) as ViewerManifest;
        const titles = ['Tasks — Supabase', 'Tasks — Nest', ...m.projects.slice(2).map((p) => p.title)];
        await page.route('**/specs/projects.json', async (route) => {
            await route.fulfill({ json: { ...m, projects: m.projects.map((p, i) => ({ ...p, title: titles[i] ?? p.title })) } });
        });
        await page.reload();
        await page.waitForFunction(() => window.archMap && performance.getEntriesByName('archMap:ready').length > 0, null, { timeout: 30000 });
        const labels = await page.locator('#project option').allTextContents();
        measure(t, labels);
        assert.equal(new Set(labels).size, labels.length, `labels collide: ${labels}`);
        assert.deepEqual(labels.slice(0, 2), ['Tasks — Supabase', 'Tasks — Nest']);
        assert.deepEqual(errors, []);
    } finally { await page.close(); }
});
