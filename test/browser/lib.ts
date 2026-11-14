// Shared helpers of the browser checks (test/browser/*.test.ts): a real Chromium driven by playwright-core with real
// input (page.mouse.wheel / move / click, CDP wheel events for the pinch). Run them with `npm run test:browser`
// (scripts/test-browser.ts starts the viewer and sets ARCH_MAP_URL); docs/browser-checks.md.
import type { CinemaLeg, CinemaSegment } from '../../types/viewer.ts';
import { appendFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';

/** What the checks read from the debug API (`window.archMap`, viewer/src/main.ts). Loose on purpose: it is a probe. */
export interface ArchMapProbe {
    project: string;
    counts(): { nodes: number; edges: number; extractedNodes: number; extractedEdges: number };
    model: { nodes: Map<string, { id: string; title: string; parent?: string | null }> };
    state: {
        focus: string | null;
        placedIds: Set<string>;
        placed: unknown[];
        hover: { type: string; id?: string } | null;
        selected: { type: string; id?: string } | null;
        folded: unknown[];
        path: { title: string; steps: unknown[]; callers: unknown[] } | null;
        step: { keys: Set<string> } | null;
    };
    scene: {
        screenCenter(id: string): { x: number; y: number } | null;
        screenRect(id: string): { x0: number; y0: number; x1: number; y1: number } | null;
        pickAt(x: number, y: number): { type: string; id?: string } | null;
        comet: { mesh: { position: { x: number; y: number; z: number } } } | null;
        camera: { position: { x: number; y: number; z: number } };
        controls: { target: { x: number; y: number; z: number } };
        view: { lit?: Set<string>; litEdges?: Set<string>; env?: Map<string, { side: string; env: { key: string } }[]> };
        shotOf(ids: Set<string>, options: { pad: number; shiftX?: number }): { toT: { x: number; y: number; z: number } } | null;
    };
    setFocus(id: string | null): void;
    scenarios: { id: string; steps: unknown[] }[];
    scenario(id?: string, step?: number): { step: number; of: number; caption: string } | null;
    cinema: { enter(i: number): void; exit(): void; go(i: number): void; state: { on: boolean; playing: boolean; phase: string; step: number | null; elapsed: number; segment?: number; leg?: CinemaSegment; journey?: CinemaLeg[]; track: { from: number; to: number; progress: number } | null } };
    frames: number;
}
declare global {
    /**
     * The map's shadow root (the site mounts the map into #app): what `document` was for the checks' DOM probes inside
     * `page.evaluate` (querySelector, getElementById, activeElement, elementFromPoint). Defined by `withMapRoot`.
     */
    function mapRoot(): ShadowRoot;
    interface Window {
        archMap: ArchMapProbe;
        /** focus changes recorded by `recordFocus` */
        __focusSeen: (string | null)[];
    }
}

export const BASE = (process.env.ARCH_MAP_URL ?? 'http://localhost:4848').replace(/\/$/, '');
/** The viewport every number in the checks was measured with. */
export const VIEWPORT = { width: 1600, height: 1000 };
/** The three public demo maps. */
export const DOCS = { tasks: '?project=tasks-supabase', library: '?project=library-nest' } as const;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Headless Chromium on the GPU (Metal on macOS). */
export function launch(): Promise<Browser> {
    const args = ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];
    return chromium.launch({ headless: true, args });
}

/** Defines `mapRoot()` in every document `page` opens (before its scripts run). */
export const withMapRoot = (page: Page) =>
    page.addInitScript(() => {
        (globalThis as unknown as { mapRoot: () => unknown }).mapRoot = () => document.getElementById('app')?.shadowRoot ?? document;
    });

/** A page of the map with console errors collected; resolves when the map is laid out and has settled. */
export async function open(browser: Browser, qs = '', settle = 2500): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await withMapRoot(page);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/' + qs);
    await page.waitForFunction(() => window.archMap && performance.getEntriesByName('archMap:ready').length > 0, null, { timeout: 30000 });
    await sleep(settle);
    return { page, errors };
}

export const focusOf = (page: Page) => page.evaluate(() => window.archMap.state.focus);

/**
 * Where to aim at `id`: the screen centre of its deepest placed ancestor-or-self; null when that is off the page
 * (inside the focused block the camera is so close that its centre projects far outside — events there are dropped).
 */
export const aim = (page: Page, id: string) => page.evaluate((target) => {
    const a = window.archMap;
    let n = a.model.nodes.get(target);
    while (n && !a.state.placedIds.has(n.id)) n = n.parent ? a.model.nodes.get(n.parent) : undefined;
    const c = n && a.scene.screenCenter(n.id);
    if (!c || !n) return null;
    const onScreen = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight;
    if (onScreen(c)) return { x: c.x, y: c.y, id: n.id };
    // A narrow map can leave a child's centre outside the viewport while part of its block is still visible.
    const rect = a.scene.screenRect(n.id);
    if (!rect) return null;
    const x0 = Math.max(0, rect.x0), x1 = Math.min(innerWidth, rect.x1);
    const y0 = Math.max(70, rect.y0), y1 = Math.min(innerHeight - 60, rect.y1);
    if (x0 >= x1 || y0 >= y1) return null;
    for (const fx of [0.5, 0.25, 0.75]) for (const fy of [0.5, 0.25, 0.75]) {
        const x = x0 + (x1 - x0) * fx, y = y0 + (y1 - y0) * fy;
        if (a.scene.pickAt(x, y)?.id === n.id) return { x, y, id: n.id };
    }
    return null;
}, id);

/** One mouse notch: `wheel(0, ∓100)` every 260 ms, as the zoom thresholds were tuned (~6 notches per level). */
export const NOTCH_MS = 260;

/**
 * Mouse notches in, aimed at `target` (re-aimed each notch), until the focus is `target`.
 * Returns the notch count and at which notch each level change happened.
 */
export async function notchesIn(page: Page, target: string, max = 60) {
    const levels: [number, string | null][] = [];
    let n = 0;
    for (; n < max; n++) {
        const f = await focusOf(page);
        if (f === target) break;
        const a = await aim(page, target);
        if (!a) break;
        await page.mouse.move(a.x, a.y);
        await page.mouse.wheel(0, -100);
        await sleep(NOTCH_MS);
        const g = await focusOf(page);
        if (g !== f) levels.push([n + 1, g]);
    }
    const last = await focusOf(page);
    await sleep(1200); // let the last flight land
    return { notches: n, reached: last === target, focus: last, levels };
}

/** Mouse notches out at the screen centre until the focus is `target` (null = the resting view). */
export async function notchesOut(page: Page, target: string | null, max = 40) {
    const levels: [number, string | null][] = [];
    let n = 0;
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    for (; n < max; n++) {
        const f = await focusOf(page);
        if (f === target) break;
        await page.mouse.wheel(0, 100);
        await sleep(NOTCH_MS);
        const g = await focusOf(page);
        if (g !== f) levels.push([n + 1, g]);
    }
    const last = await focusOf(page);
    await sleep(1200);
    return { notches: n, reached: last === target, focus: last, levels };
}

/** Focus a block through the debug API and let the flight land. */
export async function focus(page: Page, id: string, settle = 2500) {
    await page.evaluate((f) => window.archMap.setFocus(f), id);
    await sleep(settle);
}

/** Record every focus change (polled every 20 ms) into `window.__focusSeen`, starting from the current focus. */
export const recordFocus = (page: Page) => page.evaluate(() => {
    window.__focusSeen = [window.archMap.state.focus];
    const w = window as Window & { __focusTimer?: number };
    if (w.__focusTimer) return;
    w.__focusTimer = window.setInterval(() => {
        const f = window.archMap.state.focus, seen = window.__focusSeen;
        if (f !== seen[seen.length - 1]) seen.push(f);
    }, 20);
});
export const focusSeen = (page: Page) => page.evaluate(() => window.__focusSeen);

/** `n` within `[lo, hi]`, with a message that shows the whole measurement. */
export function within(n: number, lo: number, hi: number, what: string, detail?: unknown): void {
    if (n < lo || n > hi) throw new Error(`${what}: ${n}, expected ${lo}–${hi}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`);
}

/**
 * Record a measurement: `t.diagnostic` in the test output, and one JSON line in `$ARCH_MAP_MEASURE` when set
 * (how the bands in docs/browser-checks.md were collected: several runs, then the observed range).
 */
export function measure(t: { diagnostic(m: string): void; name: string }, data: unknown): void {
    const line = JSON.stringify(data);
    t.diagnostic(line);
    const out = process.env.ARCH_MAP_MEASURE;
    if (out) appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), test: t.name, data }) + '\n');
}

/** The first node id that is `id` or (case-insensitively) starts with it — generated ids carry suffixes. */
export const resolveId = (page: Page, id: string) => page.evaluate((want) => {
    const ids = [...window.archMap.model.nodes.keys()];
    return ids.includes(want) ? want : ids.find((i) => i.toLowerCase().startsWith(want.toLowerCase())) ?? null;
}, id);

/** Camera distance to the controls target (world units). */
export const distance = (page: Page) => page.evaluate(() => {
    const { camera, controls } = window.archMap.scene;
    const c = camera.position, t = controls.target;
    return Math.hypot(c.x - t.x, c.y - t.y, c.z - t.z);
});

/** Record the executed visible hops rather than inferring playback from manual seeks. */
export async function recordCinema(page: Page): Promise<void> {
    await page.evaluate(() => {
        const target = window as Window & { __cinemaSeen?: string[]; __cinemaTimer?: number };
        target.__cinemaSeen = [];
        if (target.__cinemaTimer) clearInterval(target.__cinemaTimer);
        target.__cinemaTimer = window.setInterval(() => {
            const state = window.archMap.cinema.state;
            if (state.phase !== 'step' || !state.leg) return;
            const leg = state.leg;
            const key = `${state.step}:${state.segment}:${leg.leg.kind}:${leg.from}>${leg.to}`;
            if (target.__cinemaSeen?.at(-1) !== key) target.__cinemaSeen?.push(key);
        }, 20);
    });
}
export const cinemaSeen = (page: Page) => page.evaluate(() => (window as Window & { __cinemaSeen?: string[] }).__cinemaSeen ?? []);
