// The bars and notices over the map: the focus bar, the scenario step bar, the legend, the zoom hint, the toast, the status line.
import { KINDS, ancestors, visibleAncestor, focusOf } from './model.ts';
import { stepbarHtml } from './scenario.ts';
import { announce } from './a11y.ts';
import { statusFigures, unresolvedCalls, figuresHtml } from './figures.ts';
import { esc } from './scene-util.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { ViewNode } from '../../types/viewer.ts';
import type { SceneStats } from '../../types/scene.ts';
import { keepFocus, later, cancel } from './dom.ts';
import { METRICS } from './view.ts';
import type { App } from './app.ts';

// ---------- bars over the map ----------
export function renderBars(app: App): void {
    const { state, model } = app;
    const fb = app.$('#focusbar');
    if (state.path) {
        fb.innerHTML = `<span class="fb-path">Path</span><b>${esc(state.path.title)}</b><span class="muted">${state.path.steps.length} steps</span><button class="fb-exit" data-closepath="1" title="Esc">Close ✕</button>`;
    } else if (state.focus) {
        // a single-child chain is one level (the system title rather than its sole app)
        const rest = app.restSet();
        const chain = [...ancestors(model, state.focus).reverse(), model.nodes.get(state.focus)!].filter((p) => !rest.has(p.id) && focusOf(model, p.id) === p.id);
        fb.innerHTML =
            `<button data-leave="">${VIEW_TITLE[state.view]}</button>` +
            chain.map((p, i, all) => `<span>›</span><button data-leave="${esc(p.id)}" ${i === all.length - 1 ? 'aria-current="true"' : ''}>${esc(p.title)}</button>`).join('') +
            `<button class="fb-exit" data-leave="${esc(chain.length > 1 ? chain[chain.length - 2].id : '')}" title="Esc">Leave ↑</button>`;
    } else if (app.scenarioPlace()) {
        // «Go inside» put the camera among the step's own components: say where that is, and how to step out
        const crumb = (p: ViewNode, last: boolean) => `<button data-leave="${esc(p.id)}" ${last ? 'aria-current="true"' : ''} title="Go into ${esc(p.title)}">${esc(p.title)}</button>`;
        const crumbs = (chain: ViewNode[], last = true) => chain.map((p, i) => `<span>›</span>${crumb(p, last && i === chain.length - 1)}`).join('');
        const [a, b] = app.scenarioPlace()!;
        // from one board to another: what they share once, then «from → to»
        let k = 0;
        while (b && k < a.length - 1 && k < b.length - 1 && a[k].id === b[k].id) k++;
        const route = b ? `${crumbs(a.slice(0, k), false)}<span>›</span>${a.slice(k).map((p, i, all) => crumb(p, i === all.length - 1)).join('<span>›</span>')}<span class="fb-to">→</span>${b.slice(k).map((p) => crumb(p, false)).join('<span>›</span>')}` : crumbs(a);
        fb.innerHTML =
            `<span class="fb-sc">Scenario</span><button data-scdeep="1" title="Show the scenario on the ${VIEW_TITLE[state.view].toLowerCase()}">${VIEW_TITLE[state.view]}</button>` +
            route +
            `<button class="fb-exit" data-scdeep="1" title="Turn off “Go inside”: the scenario plays on the ${VIEW_TITLE[state.view].toLowerCase()}">Leave ↑</button>`;
    } else
        fb.innerHTML =
            `<b>${VIEW_TITLE[state.view]}</b><span class="muted fb-hint">hover a block or zoom in on it</span>` +
            `<button class="fb-exit" data-view="${state.view === 'tech' ? 'client' : 'tech'}">${state.view === 'tech' ? 'Client layer' : 'Technical overview'}</button>`;
}

const VIEW_TITLE: Record<string, string> = { client: 'Client layer', tech: 'Technical overview' };

/**
 * Where «Go inside» has the current scenario step (no focus of its own): the open boards around the step's ends, top
 * down, a single-child chain as one level — one chain, or two when the step runs from one place to another. Null when
 * the step plays on the overview (nothing opened for it).
 */
export function scenarioPlace(app: App): ViewNode[][] | null {
    const { state, model } = app;
    if (state.focus || state.path || !app.deepStepIds().length) return null;
    const st = app.currentStep();
    if (!st) return null;
    const rest = app.restSet();
    const chainOf = (id: ElementId) => ancestors(model, visibleAncestor(model, state.expanded, id).id).reverse().filter((p) => !rest.has(p.id) && focusOf(model, p.id) === p.id);
    const chains = (st.kind === 'element' ? [st.element] : [st.from, st.to]).map(chainOf).filter((c) => c.length);
    if (!chains.length) return null;
    const key = (c: ViewNode[]) => c.map((p) => p.id).join('>');
    const [a, b] = chains;
    // one place when both ends are on the same board, or one board holds the other
    const within = (x: ViewNode[], y: ViewNode[]) => `${key(x)}>`.startsWith(`${key(y)}>`); // board chain x lies inside board chain y
    if (!b || within(b, a)) return [b ?? a];
    if (within(a, b)) return [a];
    return [a, b];
}

/**
 * The heights the narrow layout and the legend need (CSS custom properties on the host): the step bar's, the header's,
 * and the host's own (the narrow stage is sized from the host, not the viewport: style.css).
 */
function syncBarHeights(app: App): void {
    const root = app.host.style;
    root.setProperty('--host-h', `${app.host.clientHeight}px`);
    root.setProperty('--sb-h', `${app.$('#stepbar').hidden ? 0 : Math.ceil(app.$('#stepbar').getBoundingClientRect().height)}px`);
    root.setProperty('--top-h', `${Math.ceil(app.$('.top').getBoundingClientRect().height)}px`);
}

export function renderStepbar(app: App): void {
    const { state } = app;
    const sc = app.currentScenario();
    const bar = app.$('#stepbar');
    app.$('#stage').classList.toggle('playing', !!sc && !state.path);
    if (!app.ui.barWatch) {
        app.ui.barWatch = new ResizeObserver(() => syncBarHeights(app));
        app.ui.barWatch.observe(bar);
        app.ui.barWatch.observe(app.$('.top'));
        app.ui.barWatch.observe(app.host);
    }
    if (!sc || state.path) return ((bar.hidden = true), syncBarHeights(app));
    bar.hidden = false;
    keepFocus(bar, () => (bar.innerHTML = stepbarHtml(sc, state.scenario!.i, { camera: state.scCamera, deep: state.scDeep })));
    syncBarHeights(app);
    // the one place a step is announced (the step bar and the panel are not live regions)
    announce(app, `Step ${state.scenario!.i + 1} of ${sc.steps.length}: ${sc.steps[state.scenario!.i]?.caption ?? ''}`);
}

/** Why a relation kind is not drawn: the three off by default say so in words, a kind the viewer turned off says "hidden". */
const kindNote = (kind: string, on: boolean): string => (on ? '' : ` <small>${KINDS[kind].on ? 'hidden' : 'off by default'}</small>`);

// legend: shapes, and the protocols that double as filters
export function renderLegend(app: App): void {
    const { state } = app;
    const shapes = [
        ['rack', 'module, folder'], ['chip', 'controller'], ['cpu', 'service, component'], ['disks', 'repository'],
        ['can', 'table'], ['cage', 'external system'], ['screen', 'Vue component'], ['rail', 'event bus, queue, jobs; a rail under its column'],
    ];
    const m = METRICS[state.tint];
    const open = app.$<HTMLDetailsElement>('#legend details')?.open ?? false;
    const dots = Object.entries(app.kinds).filter(([k]) => state.filters[k]).map(([, v]) => `<i class="dot" data-style="--c:${v.color}" title="${esc(v.title)}"></i>`).join('');
    app.$('#legend').innerHTML = `<details ${open ? 'open' : ''}><summary>Legend <span class="dots">${dots}</span></summary>
      <ul class="lg-shapes">${shapes.map(([k, t]) => `<li><i class="ico ico-${k}"></i>${t}</li>`).join('')}</ul>
      <div class="lg-h">Relations <span class="muted">· click to show or hide</span></div>
      <ul class="lg-kinds">${Object.entries(app.kinds).map(([k, v]) => `<li><button data-kind="${k}" aria-pressed="${state.filters[k]}" data-style="--c:${v.color}"><i></i><span>${esc(v.title)}${kindNote(k, state.filters[k])}</span></button></li>`).join('')}</ul>
      ${state.tint !== 'kind' ? `<div class="lg-h">Coloring: ${esc(m.title)}</div><div class="lg-ramp"><span>few</span><i></i><span>many</span></div><div class="muted small">${esc(m.hint)}</div>` : ''}
    </details>`;
}

/**
 * The line over the map that says what the wheel is doing: leaving a level (with how close it is), heading for a block,
 * or at the bottom. `html` is trusted markup (names escaped by the caller); `p` 0…1 draws a progress bar. It goes away
 * on its own once the wheel stops.
 */
export function zoomHint(app: App, html: string | null, p: number | null = null): void {
    const el = app.$('#zoomhint');
    cancel(app, app.ui.hintTimer);
    if (!html) return void (el.hidden = true);
    el.hidden = false;
    el.innerHTML = `<span>${html}</span>${p === null ? '' : `<i data-style="--p:${Math.round(Math.max(0, Math.min(1, p)) * 100)}%"></i>`}`;
    app.ui.hintTimer = later(app, () => (el.hidden = true), 1800);
}

/**
 * A zoom hint is about one direction of the wheel ("Zooming toward …" in, "Zoom out more to leave …" out): it goes
 * with the first event of the other direction, not at the next zoom decision (that waits while the camera flies and
 * right after a level change, and the hint stayed up while the wheel already went the other way).
 */
export function dropHintOnTurn(app: App): void {
    let last: 'in' | 'out' | null = null;
    app.scene.labels.domElement.addEventListener('wheel', (e) => {
        if (!e.deltaY) return;
        const dir = e.deltaY < 0 ? 'in' : 'out';
        if (last && dir !== last) zoomHint(app, null);
        last = dir;
    }, { passive: true, capture: true, signal: app.signal });
}

// ---------- toast and status ----------
export function toast(app: App, text: string): void {
    const t = app.$('#toast');
    t.textContent = text;
    t.hidden = false;
    cancel(app, app.ui.toastTimer);
    app.ui.toastTimer = later(app, () => (t.hidden = true), 1400);
}

/**
 * The status line: what the legend's filters hide now and the calls the specs could not resolve (each a break in a
 * Path), and the mouse hints until the person first moves the map (or for 10 s). Once they have moved it, the hints do
 * not come back on later visits. The renderer's counters (blocks, in frame, names) are on the debug API
 * (`archMap.stats`), not here.
 */
export function renderStats(app: App, s: SceneStats): void {
    const { model, state } = app;
    const { ui } = app;
    ui.lastStats = s;
    ui.unresolved ??= unresolvedCalls(model.merged.elements);
    const figures = statusFigures(state.hiddenByFilters ?? 0, ui.unresolved);
    const html =
        figures.map(({ figure, why }) => `<span title="${why}">${figuresHtml([figure])}</span>`).join('') +
        (ui.statusHints ? `<span class="muted">drag: pan · Shift + drag: rotate · wheel: zoom in and out · Esc: back</span>` : figures.length ? '' : '<span class="muted"><kbd>?</kbd> controls and shortcuts</span>');
    // the html last written is kept: this runs on every drawn frame
    if (html !== ui.statusHtml) app.$('#status').innerHTML = ui.statusHtml = html;
}

export function dropStatusHints(app: App, seen: boolean): void {
    const { ui } = app;
    if (!ui.statusHints) return;
    ui.statusHints = false;
    if (seen) app.prefs.set('hintsSeen', true); // a private window, or no storageKey: they show again next time
    if (ui.lastStats) app.renderStats(ui.lastStats);
}
