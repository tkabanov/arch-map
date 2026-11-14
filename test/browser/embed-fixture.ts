// Shared server, pages and instrumentation for the built-package Chromium regressions in embed.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page, CDPSession } from 'playwright-core';
import { launch, VIEWPORT } from './lib.ts';
import type { ViewerManifest } from '../../types/project.ts';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPECS = join(root, 'viewer', 'public', 'specs');

/** What the checks call on the page (embed.html's window). */
interface Probe {
    state: { focus: string | null; selected: { id?: string } | null; placedIds: Set<string> };
    model: { nodes: Map<string, { id: string; children: unknown[]; parent?: string | null }> };
    scene: { screenCenter(id: string): { x: number; y: number } | null; pickAt(x: number, y: number): { type: string; id?: string } | null };
    frames: number;
}
export interface Handle { setTheme(theme: string): Promise<void>; setSpecs(specs: unknown): Promise<void>; ready: Promise<void>; destroy(): void; probe: Probe | null; focus(id: string | null): void }
declare global {
    interface Window {
        ArchMap: { mount(el: HTMLElement, o: Record<string, unknown>): Handle; SCHEMA_MAJOR: string };
        maps: Record<string, Handle>;
        events: Record<string, unknown[]>;
        gl: { live: number; made: number };
        rafCalls: number;
    }
}

let browser: Browser;
let server: Server;
let base = '';
export const requests: string[] = [];
let manifest: ViewerManifest;

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json' };

/** The page that loads the ES modules: `<arch-map>` with three from an import map. */
const ELEMENT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<script type="importmap">{ "imports": { "three": "/three/build/three.module.js", "three/": "/three/" } }</script>
<link rel="stylesheet" href="/dist/fonts.css"></head><body style="margin:0">
<arch-map id="el" style="display:block;width:1000px;height:600px"></arch-map>
<script type="module">import { mount } from '/dist/index.js'; import '/dist/element.js'; window.ArchMap = { mount }; window.elementReady = true;</script>
</body></html>`;

/**
 * The page that runs the React wrapper from dist/react.js: React 18 and ReactDOM from node_modules (their UMD builds;
 * React 18 ships no ES module), `react` mapped to a shim over the global, three from an import map.
 */
const REACT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<script src="/umd/react/react.development.js"></script><script src="/umd/react-dom/react-dom.development.js"></script>
<script type="importmap">{ "imports": { "three": "/three/build/three.module.js", "three/": "/three/", "react": "/shim/react.js" } }</script>
<link rel="stylesheet" href="/dist/fonts.css"></head><body style="margin:0">
<div id="root" style="width:900px;height:600px"></div>
<script type="module">import { ArchMap } from '/dist/react.js'; window.ArchMapReact = ArchMap; window.reactReady = true;</script>
</body></html>`;
/** A page under a strict Content-Security-Policy: no 'unsafe-inline' anywhere; the host sized by an external stylesheet. */
const CSP_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'">
<link rel="stylesheet" href="/dist/fonts.css"><link rel="stylesheet" href="/csp.css"></head><body>
<div id="m"></div>
<script src="/csp.js"></script><script src="/dist/arch-map.iife.js"></script>
</body></html>`;
const CSP_CSS = 'body { margin: 0 } #m { width: 900px; height: 560px }';
const CSP_JS = "window.violations = []; document.addEventListener('securitypolicyviolation', (e) => window.violations.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '')));";

/**
 * A documentation page around maps: something above them that may grow (#spacer), a wide map (#w), a narrow one (#n,
 * scrolling inside), a host in a flex row with no width of its own (#f), a <figure> (no shadow root) and a long tail
 * (the page scrolls).
 */
const LAYOUT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<link rel="stylesheet" href="/dist/fonts.css">
<style>body { margin: 0; font: 15px Georgia, serif } #spacer { height: 0 } #w { width: 1000px; height: 560px } #n { width: 700px; height: 520px } .flex { display: flex } #f { height: 300px } .tail { height: 2000px }</style></head><body>
<div id="spacer"></div>
<div id="w"></div>
<div id="n"></div>
<div class="flex"><div id="f"></div></div>
<figure id="fig"></figure>
<div class="tail"></div>
<script src="/dist/arch-map.iife.js"></script>
</body></html>`;

const REACT_SHIM = 'const R = window.React; export default R; export const { createElement, useEffect, useRef, useState, Fragment } = R;';

function serve(): Promise<void> {
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        requests.push(url.pathname);
        if (url.pathname === '/pending-body.json') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"schemaVersion":'); // successful headers, unfinished body until the client aborts
            return;
        }
        if (url.pathname === '/element.html') return void res.writeHead(200, { 'content-type': 'text/html' }).end(ELEMENT_PAGE);
        if (url.pathname === '/react.html') return void res.writeHead(200, { 'content-type': 'text/html' }).end(REACT_PAGE);
        const pages: Record<string, [string, string]> = { '/csp.html': ['text/html', CSP_PAGE], '/csp.css': ['text/css', CSP_CSS], '/csp.js': ['text/javascript', CSP_JS], '/layout.html': ['text/html', LAYOUT_PAGE] };
        if (pages[url.pathname]) return void res.writeHead(200, { 'content-type': pages[url.pathname][0] }).end(pages[url.pathname][1]);
        if (url.pathname === '/shim/react.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(REACT_SHIM);
        const routes: [string, string][] = [['/embed.html', join(root, 'test', 'browser', 'embed.html')], ['/dist/', join(root, 'packages', 'viewer', 'dist') + '/'], ['/specs/', SPECS + '/'], ['/three/', join(root, 'node_modules', 'three') + '/'], ['/umd/react/', join(root, 'node_modules', 'react', 'umd') + '/'], ['/umd/react-dom/', join(root, 'node_modules', 'react-dom', 'umd') + '/']];
        const hit = routes.find(([p]) => url.pathname === p || (p.endsWith('/') && url.pathname.startsWith(p)));
        const file = hit && normalize(hit[1] + (hit[0].endsWith('/') ? decodeURIComponent(url.pathname.slice(hit[0].length)) : ''));
        if (!file || !file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end('not found');
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        base = `http://127.0.0.1:${a && typeof a === 'object' ? a.port : 0}`;
        resolve();
    }));
}

export async function startEmbed(): Promise<void> {
    const b = spawnSync(process.execPath, [join(root, 'scripts', 'build-lib.ts'), '--pack'], { cwd: root, stdio: 'inherit' });
    assert.equal(b.status, 0, 'npm run lib:pack');
    manifest = JSON.parse(readFileSync(join(SPECS, 'projects.json'), 'utf8')) as ViewerManifest;
    await serve();
    browser = await launch();
}
export async function stopEmbed(): Promise<void> {
    await browser?.close();
    server?.close();
}

/** The two projects the maps show: the default and the next one. */
export const twoProjects = () => {
    const def = manifest.projects.find((p) => p.name === manifest.default) ?? manifest.projects[0];
    const other = manifest.projects.find((p) => p !== def) ?? def;
    return [def, other].map((p) => ({ name: p.name, urls: p.open.map((d) => `/specs/${p.name}/${d}`) }));
};

/** embed.html with console errors collected, WebGL contexts and animation frames counted from the first script on. */
export async function openEmbed(path = '/embed.html'): Promise<{ page: Page; errors: string[]; warnings: string[] }> {
    const page = await browser.newPage({ viewport: VIEWPORT });
    const errors: string[] = [], warnings: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warning') warnings.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => {
        window.gl = { live: 0, made: 0 };
        const get = HTMLCanvasElement.prototype.getContext;
        const seen = new WeakSet<HTMLCanvasElement>();
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
            const ctx = (get as (this: HTMLCanvasElement, k: string, ...r: unknown[]) => unknown).call(this, kind, ...rest);
            if (ctx && /webgl/.test(kind) && !seen.has(this)) {
                seen.add(this);
                window.gl.live++;
                window.gl.made++;
                this.addEventListener('webglcontextlost', () => window.gl.live--);
            }
            return ctx;
        } as typeof get;
        window.rafCalls = 0;
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => (window.rafCalls++, raf(cb));
        window.maps = {};
        window.events = {};
    });
    await page.goto(base + path);
    return { page, errors, warnings };
}

/** Listeners on window and document (CDP), with their types: what a map leaves behind is in the difference. */
export async function pageListeners(cdp: CDPSession): Promise<string[]> {
    const out: string[] = [];
    for (const what of ['window', 'document']) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: what });
        const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId! });
        out.push(...listeners.map((l) => `${what}:${l.type}`));
    }
    return out.sort();
}

/** Mounts map `key` into `#sel` (`how` is the options' expression; `specs` documents are fetched first when given). */
export const mountMap = (page: Page, name: string, selector: string, options: Record<string, unknown>) =>
    page.evaluate(async ({ key, sel, how }) => {
        const opts: Record<string, unknown> = { debug: true, ...how };
        window.events[key] = [];
        opts.onFocus = (id: unknown) => window.events[key].push(['focus', id]);
        opts.onSelect = (hit: unknown) => window.events[key].push(['select', hit]);
        opts.onError = (e: { title: string }) => window.events[key].push(['error', e.title]);
        if (how.fetchSpecs) {
            opts.specs = await Promise.all((how.fetchSpecs as string[]).map(async (u) => ({ name: u.split('/').pop(), doc: await (await fetch(u)).json() })));
            delete opts.fetchSpecs;
        }
        const h = (window.maps[key] = window.ArchMap.mount(document.querySelector<HTMLElement>(sel)!, opts));
        try {
            await h.ready;
            return 'ready';
        } catch (e) {
            return `rejected: ${(e as Error).message}`;
        }
    }, { key: name, sel: selector, how: options });

/** The screen point of a block of map `key` that the pointer picks there, a root block (the client layer). */
export const blockOf = (page: Page, key: string) => page.evaluate((k) => {
    const a = window.maps[k].probe!;
    for (const id of a.state.placedIds) {
        const n = a.model.nodes.get(id);
        if (!n || n.parent || !n.children.length) continue;
        const c = a.scene.screenCenter(id);
        if (c && a.scene.pickAt(c.x, c.y)?.id === id) return { id, ...c };
    }
    return null;
}, key);

export const state = (page: Page, key: string) => page.evaluate((k) => {
    const a = window.maps[k].probe!;
    return { focus: a.state.focus, selected: a.state.selected?.id ?? null };
}, key);

