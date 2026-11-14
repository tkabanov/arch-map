// Playing a scenario: opening it at a step, the camera for a step, stepping, the «go inside» and «camera follows» choices,
// what a step sends.
import { stepView, contractHtml } from './scenario.ts';
import { contractShapes } from './envelopes.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { ScenarioStep } from '../../types/viewer.ts';
import { later } from './dom.ts';
import type { App } from './app.ts';
import type { ViewScenario } from '../../types/viewer.ts';

export function currentScenario(app: App): ViewScenario | null {
    const { state, scenarios } = app;
    return state.scenario ? scenarios.find((s) => s.id === state.scenario!.id) ?? null : null;
}

/**
 * Opens scenario `id` at step `i` (0-based): nothing opens or closes. The camera shows the step (its blocks framed) when
 * «Camera follows steps» is on, else it only pans when the step is out of frame; `camera: false` leaves it to the caller.
 */
export function playScenario(app: App, id: string, i = 0, { camera = true }: { camera?: boolean } = {}): void {
    const { state, scenarios, cine } = app;
    const sc = scenarios.find((s) => s.id === id);
    if (!sc) return app.toast(`No such scenario: ${id}`);
    state.path = null;
    state.scenario = { id, i: Math.max(0, Math.min(sc.steps.length - 1, i)) };
    state.selected = null;
    app.relayout();
    if (camera && !cine.on) later(app, () => app.stepCamera(), 30);
}

export function stepCamera(app: App): void {
    const { state, scene } = app;
    // the step and the way to it from the last one
    const nodes = state.step && new Set([...state.step.nodes, ...state.step.bridge.nodes]);
    if (!nodes?.size) return;
    if (!state.scCamera) return scene.keepInFrame(nodes);
    scene.frameIds(nodes, { pad: nodes.size > 1 ? 1.5 : 2.2, dur: 1000 });
}

export function setScDeep(app: App, on: boolean): void {
    const { state, cine } = app;
    state.scDeep = on;
    app.prefs.set('scDeep', on); // a private window, or no storageKey: the choice lasts for this map
    app.relayout();
    if (!cine.on) later(app, () => app.stepCamera(), 30);
}

export function setScCamera(app: App, on: boolean): void {
    const { state } = app;
    state.scCamera = on;
    app.prefs.set('scCamera', on); // a private window, or no storageKey: the choice lasts for this map
    app.renderStepbar();
    if (on) app.stepCamera();
}

export function stepBy(app: App, d: number): void {
    const { state } = app;
    const sc = app.currentScenario();
    if (!sc) return;
    const i = Math.max(0, Math.min(sc.steps.length - 1, state.scenario!.i + d));
    if (i !== state.scenario!.i) app.playScenario(sc.id, i);
}

export function closeScenario(app: App): void {
    const { state } = app;
    app.exitCinema();
    state.scenario = null;
    app.relayout();
}

/** Blocks every step of the scenario touches at this level: the stage of the establishing and closing shots. */
export function scenarioStage(app: App): Set<ElementId> {
    const { state, model } = app;
    const ids = new Set<ElementId>();
    for (const st of app.currentScenario()!.steps) for (const id of stepView(model, state.expanded, st).nodes) ids.add(id);
    return ids;
}

/** What a scenario step sends (its contract's request and response shapes), as cards; '' when it has no contract. */
export function stepContractHtml(app: App, step: ScenarioStep | null | undefined): string {
    const { model, envCtx } = app;
    if (!step?.contract) return '';
    const t = (id: ElementId) => model.nodes.get(id)?.title ?? id;
    return contractHtml(contractShapes(envCtx, step.contract), step.kind === 'edge' ? { from: t(step.from), to: t(step.to) } : {});
}
