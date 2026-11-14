// What a click on an action button (in the panel, the card, the bars) and a key press do. One handler for each in map.ts;
// the buttons name their action in a `data-*` attribute. The long if-chains are cut into groups.
import { visibleAncestor } from './model.ts';
import { isNarrow, revealInMap, targetOf } from './dom.ts';
import type { App } from './app.ts';

const ACTIONS = '[data-focus],[data-path],[data-select],[data-closepath],[data-leave],[data-step],[data-node],[data-edge],[data-view],[data-scenario],[data-scstep],[data-goto],[data-scclose],[data-env],[data-sccam],[data-scdeep],[data-cinema],[data-cplay],[data-cstep],[data-cgoto],[data-cfull],[data-cexit]';

/** One click handler for the action buttons in the panel, the card and the bars. */
export function onDocumentClick(app: App, e: MouseEvent): void {
    if ((e.target as Element).closest('.labels')) return; // the map handles its own clicks
    const t = (e.target as Element).closest<HTMLElement>(ACTIONS);
    if (!t) return;
    app.hideCard();
    if (t.dataset.view) return app.setView(t.dataset.view);
    if (scenarioAction(app, t)) return;
    navigationAction(app, t);
}

/** The scenario picker, the step bar and the cinema's controls. */
function scenarioAction(app: App, t: HTMLElement): boolean {
    const { state, cine } = app;
    // the picker opens a scenario at its first step; «▶» in the overview plays it
    if (t.dataset.scenario) return (app.$('#scmenu').hidden = true), t.dataset.open ? app.playScenario(t.dataset.scenario, 0) : (app.playScenario(t.dataset.scenario, 0, { camera: false }), app.enterCinema(0)), true;
    if (t.dataset.sccam) return app.setScCamera(!state.scCamera), true;
    if (t.dataset.scdeep) return app.setScDeep(!state.scDeep), true;
    if (t.dataset.cinema !== undefined) return app.enterCinema(Number(t.dataset.cinema)), true;
    if (t.dataset.cplay) return cine.playing ? app.pauseCinema() : app.resumeCinema(), true;
    if (t.dataset.cstep) return app.cineGo(cine.phase === 'end' ? app.currentScenario()!.steps.length - 1 : state.scenario!.i + Number(t.dataset.cstep)), true;
    if (t.dataset.cgoto !== undefined) return app.cineGo(Number(t.dataset.cgoto)), true;
    if (t.dataset.cfull) return app.toggleFullscreen(), true;
    if (t.dataset.cexit) return app.exitCinema(), true;
    if (t.dataset.scstep) return app.stepBy(Number(t.dataset.scstep)), true;
    if (t.dataset.goto !== undefined && state.scenario) return app.playScenario(state.scenario.id, Number(t.dataset.goto)), true;
    if (t.dataset.scclose) return app.closeScenario(), true;
    return false;
}

/** Going to a thing: the focus, a Path, a selection, a step of a Path, an envelope, a relation. */
function navigationAction(app: App, t: HTMLElement): unknown {
    const { state, model, scene } = app;
    if (t.dataset.focus !== undefined) return app.setFocus(t.dataset.focus || null, { enter: true }); // «Enter ⤵»
    if (t.dataset.path) {
        const [id, m] = t.dataset.path.split('|');
        return app.startPath(id, m);
    }
    if (t.dataset.select) return app.select({ type: 'node', id: t.dataset.select }), isNarrow(app.host) && revealInMap(app.$('.app'), app.$('#panel'), scene.motion); // the panel is below the map
    if (t.dataset.closepath) return app.closePath();
    if (t.dataset.leave !== undefined) return app.setFocus(t.dataset.leave || null);
    if (t.dataset.step !== undefined) {
        const id = visibleAncestor(model, state.expanded, t.dataset.node!).id;
        scene.selected = id;
        scene.applyView();
        return scene.flyTo(id);
    }
    if (t.dataset.env) return app.select({ type: 'envelope', id: t.dataset.env });
    if (t.dataset.edge) return app.select({ type: 'edge', id: t.dataset.edge });
    if (t.dataset.node) return app.goTo(t.dataset.node);
}

/** The map's keys (the whole page's with keyboard: 'page'): the cinema's, the scenario's, and Esc, which steps back out. */
export function onWindowKey(app: App, e: KeyboardEvent): void {
    if (!app.keyFor(e)) return;
    const target = targetOf(e); // the element inside the map's shadow root, not its host
    if (target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return; // typing, sliders
    const { state, cine } = app;
    if (cine.on) return cinemaKey(app, e);
    if (state.scenario && !state.path && e.key === ' ' && !target.closest?.('button')) {
        e.preventDefault();
        return app.enterCinema(state.scenario.i);
    }
    if (state.scenario && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        return app.stepBy(e.key === 'ArrowRight' ? 1 : -1);
    }
    if (e.key !== 'Escape') return;
    app.$('#viewmenu').hidden = true;
    app.$('#scmenu').hidden = true;
    stepBack(app);
}

/** While the cinema plays: Space pauses, ← → step, F full screen, Esc leaves. */
function cinemaKey(app: App, e: KeyboardEvent): void {
    const { state, cine } = app;
    const keys: Record<string, () => unknown> = { ' ': () => (cine.playing ? app.pauseCinema() : app.resumeCinema()), ArrowRight: () => app.cineGo(state.scenario!.i + 1), ArrowLeft: () => app.cineGo(state.scenario!.i - 1), Escape: () => app.exitCinema(), f: app.toggleFullscreen, F: app.toggleFullscreen, а: app.toggleFullscreen, А: app.toggleFullscreen };
    if (!keys[e.key]) return;
    e.preventDefault();
    app.cineWake();
    keys[e.key]();
}

/** Esc steps back out: a path, a selection, the focus; at the top it closes the scenario. */
function stepBack(app: App): void {
    const { state } = app;
    if (state.path) return app.closePath();
    if (state.selected && state.selected.id !== state.focus) return app.select(state.focus && state.selected.type !== 'envelope' ? { type: 'node', id: state.focus } : null);
    if (state.focus) return app.setFocus(app.upOf(state.focus)?.id ?? null);
    if (state.scenario) app.closeScenario();
}
