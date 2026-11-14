// The header's menus and the legend's filters of one map: Scenarios (the picker), View (angle, coloring, spacing,
// autofocus, pulses, glow, motion), the relation kinds in the legend. A press outside a menu closes it.
import { pickerHtml, noScenariosHtml } from './scenario.ts';
import { syncExpanded } from './a11y.ts';
import { METRICS } from './view.ts';
import { esc } from './scene-util.ts';
import type { App } from './app.ts';

/** A press anywhere outside `menu` and its button (on the page too) closes it. */
function closeOutside(app: App, menu: string, button: string): void {
    document.addEventListener('pointerdown', (e) => {
        const inside = e.composedPath().some((el) => el instanceof Element && el.matches(`${menu}, ${button}`) && app.root.contains(el));
        if (!inside) app.$(menu).hidden = true;
    }, { signal: app.signal });
}

export function setupMenus(app: App): void {
    const { state, scenarios } = app;
    const on = { signal: app.signal };
    // the button stays on maps without a scenario: the menu then says so and where scenarios come from
    syncExpanded(app.$('#scbtn'), app.$('#scmenu'), app.signal);
    syncExpanded(app.$('#viewbtn'), app.$('#viewmenu'), app.signal);
    app.$('#scbtn').addEventListener('click', () => {
        app.$('#scmenu').innerHTML = scenarios.length ? pickerHtml(scenarios, state.scenario?.id) : noScenariosHtml();
        app.$('#scmenu').hidden = !app.$('#scmenu').hidden;
    }, on);
    closeOutside(app, '#scmenu', '#scbtn');
    app.$('#legend').addEventListener('click', (e) => {
        const b = (e.target as Element).closest<HTMLElement>('[data-kind]');
        if (!b) return;
        state.filters[b.dataset.kind!] = !state.filters[b.dataset.kind!];
        b.setAttribute('aria-pressed', String(state.filters[b.dataset.kind!]));
        app.relayout();
    }, on);
    setupViewMenu(app);
}

function setupViewMenu(app: App): void {
    const { state, scene } = app;
    const on = { signal: app.signal };
    app.$('#viewbtn').addEventListener('click', () => (app.$('#viewmenu').hidden = !app.$('#viewmenu').hidden), on);
    closeOutside(app, '#viewmenu', '#viewbtn');
    app.$('#tints').innerHTML = Object.entries(METRICS).map(([k, m]) => `<button data-tint="${k}" aria-pressed="${k === state.tint}">${esc(m.title)}</button>`).join('');
    app.$('#viewmenu').addEventListener('click', (e) => {
        const b = (e.target as Element).closest('button');
        if (!b) return;
        if (b.dataset.preset) scene.preset(b.dataset.preset);
        if (b.dataset.fit) app.frameFocus();
        if (b.dataset.tint) {
            state.tint = b.dataset.tint;
            app.root.querySelectorAll('[data-tint]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
            app.renderLegend();
            app.updateView();
        }
    }, on);
    const checked = (e: Event) => (e.target as HTMLInputElement).checked;
    app.$('#gap').addEventListener('input', (e) => ((state.gap = Number((e.target as HTMLInputElement).value)), app.relayout()), on);
    app.$('#auto').addEventListener('change', (e) => (state.auto = checked(e)), on);
    app.$('#glow').addEventListener('change', (e) => ((scene.glow = checked(e)), (scene.dirty = true)), on);
    app.$('#pulses').addEventListener('change', (e) => ((state.pulses = checked(e)), app.updateView()), on);
    app.$('#motion').addEventListener('change', (e) => setMotion(app, checked(e)), on);
}

/** «Camera and layout motion» (View menu, prefers-reduced-motion): off, flights and layout changes are cuts and the CSS entrances stop. */
export function setMotion(app: App, on: boolean): void {
    app.scene.motion = on;
    app.host.classList.toggle('still', !on);
}
