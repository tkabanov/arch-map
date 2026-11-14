// The debug API of one map: the handle's `probe` (with `debug: true`), on the site also `window.archMap`. For the
// browser console and the browser checks (test/browser/lib.ts reads it); not a stable API.
import type { App } from './app.ts';
import type { setupHelp } from './help.ts';

export type MapProbe = ReturnType<typeof debugApi>;

export function debugApi(app: App, project: string, help: ReturnType<typeof setupHelp>) {
    const { model, state, scene, scenarios } = app;
    /** Everything open, every relation kind on (for the checks that compare against the full relation set). */
    function expandAll() {
        state.all = true;
        state.focus = null;
        state.path = null;
        for (const k of Object.keys(state.filters)) state.filters[k] = true;
        app.renderLegend();
        app.relayout();
    }
    /** Visible nodes and folded edges; `extracted*` leave out hand-written (authored) and synthetic ones. */
    function counts() {
        const placed = state.placed ?? [];
        return {
            nodes: placed.length,
            edges: state.folded.length,
            extractedNodes: placed.filter((n) => n.provenance && n.provenance !== 'authored').length,
            extractedEdges: state.folded.filter((e) => e.raw.some((r) => r.provenance !== 'authored')).length,
        };
    }
    /** Play scenario `id` at `step` (1-based); no id closes it. Returns where it is. */
    function scenarioApi(id?: string, step = 1) {
        if (!id) return app.closeScenario(), null;
        app.playScenario(id, step - 1);
        const sc = app.currentScenario();
        return sc ? { id: sc.id, step: state.scenario!.i + 1, of: sc.steps.length, caption: sc.steps[state.scenario!.i].caption } : null;
    }
    return {
        project,
        /** the map's shadow root (the browser checks query the map's elements in it) */
        root: app.root,
        model, state, scene, setFocus: app.setFocus, select: app.select, startPath: app.startPath, closePath: app.closePath, goTo: app.goTo, expandAll, counts, scenarios, setView: app.setView, scenario: scenarioApi,
        cinema: { enter: app.enterCinema, exit: app.exitCinema, pause: app.pauseCinema, resume: app.resumeCinema, go: app.cineGo, get state() { return app.cinemaState(); } },
        get frames() {
            return scene.frames;
        },
        /** The renderer's counters the status line used to show: blocks drawn (of the model's), in frame, names, relations. */
        get stats() {
            return { ...scene.stats, of: model.nodes.size };
        },
        help,
    };
}
