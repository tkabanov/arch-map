// Cinema follows the scenario's ordered journey: requests, processing, returns and event-topic branches.
// One elapsed timeline preserves the paused position; the camera and marker travel every visible transport hop.
import { cinemaEventFork } from './cinema-flow.ts';
import { visibleAncestor } from './model.ts';
import { contractShapes } from './envelopes.ts';
import { stepSeconds, cinemaHtml, contractHtml } from './scenario.ts';
import { later, cancel, isFullscreen } from './dom.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { App } from './app.ts';
import type { CinemaLeg, CinemaPlayback, CinemaSegment } from '../../types/viewer.ts';

const TITLE_MS = 3400;
/** The overlay with the letterbox and the subtitles (made by setupCinema, one per map). */
const cineOf = (app: App): HTMLDivElement => app.ui.cineEl!;
/** The black cut between the map and the cinema (over the map's host only). */
const veil = (app: App, on: boolean) => app.ui.veilEl!.classList.toggle('on', on);

/** The overlay and the veil are made once, after the map's own elements; the pointer over the stage wakes the controls. */
export function setupCinema(app: App): void {
    const { cine, signal } = app;
    const cineEl = (app.ui.cineEl = document.createElement('div'));
    cineEl.id = 'cinema';
    cineEl.hidden = true;
    app.$('#stage').appendChild(cineEl);
    const veilEl = (app.ui.veilEl = document.createElement('div'));
    veilEl.id = 'veil';
    app.root.appendChild(veilEl);
    cineEl.addEventListener('pointermove', () => cineWake(app), { signal });
    app.$('#stage').addEventListener('pointermove', () => cine.on && cineWake(app), { signal });
}

export function cineAt(app: App, ms: number, fn: () => unknown): number {
    const { cine } = app;
    const generation = cine.generation;
    return cine.timers.push(later(app, () => { if (generation === cine.generation) fn(); }, ms));
}

export function scTitle(app: App, id: ElementId): string {
    const { model } = app;
    return model.nodes.get(id)?.title ?? id;
}

export function clearCine(app: App): void {
    const { cine } = app;
    cine.generation = (cine.generation ?? 0) + 1;
    cine.timers.forEach((t) => cancel(app, t));
    cine.timers = [];
}

/** The contract documents came in while a step plays: its card is drawn again. */
export function refreshCinemaContract(app: App): void {
    const { cine } = app;
    const aside = cine.on && cine.phase === 'step' && cineOf(app).querySelector('.cn-contract');
    if (aside) aside.innerHTML = cinemaContract(app);
}

export function renderCinema(app: App): void {
    const { state, cine } = app;
    const sc = app.currentScenario();
    app.$('#stage').classList.toggle('cn-titlecard', cine.on && cine.phase !== 'step');
    if (!sc) return;
    const key = `${cine.phase}:${state.scenario!.i}`;
    if (cineOf(app).dataset.key === key && cine.phase === 'step') {
        cineOf(app).querySelector('.cn-who')!.textContent = cinemaDirection(app);
        cineOf(app).querySelector('.cn-contract')!.innerHTML = cinemaContract(app);
        return;
    }
    cineOf(app).dataset.key = key;
    cineOf(app).innerHTML = cinemaHtml(sc, state.scenario!.i, { phase: cine.phase, playing: cine.playing, stepMs: cine.ms, elapsed: cine.elapsed, title: (id) => scTitle(app, id), contract: cinemaContract(app), journey: cinemaDirection(app) });
}

function cinemaContract(app: App): string {
    const leg = app.cine.segments?.[app.cine.segment ?? 0]?.leg;
    if (!leg || !leg.edge) return '';
    const side = leg.kind === 'response' ? 'response' : 'request';
    const shapes = contractShapes(app.envCtx, leg.contract).filter((shape) => shape.side === side);
    if (!shapes.length) return leg.kind === 'response' ? '<p class="ct-route">Return of control · payload unspecified</p>' : '';
    return contractHtml(shapes, { from: scTitle(app, leg.edge.from), to: scTitle(app, leg.edge.to) });
}

function cinemaDirection(app: App): string {
    const segment = app.cine.segments?.[app.cine.segment ?? 0];
    if (!segment) return '';
    if (segment.frame) {
        const branches = cinemaEventFork(app.model, app.currentScenario()!.flow!, segment.leg).slice(1);
        return `Independent event branches · ${scTitle(app, segment.leg.to)} → ${branches.map((leg) => scTitle(app, leg.to)).join(' · ')}`;
    }
    const labels = { request: 'Request', response: 'Response', delivery: 'Event delivery · branches may run independently', processing: 'Processing', attention: 'Camera returns to topic · no response', independent: 'Independent action', unspecified: 'Connection unspecified' };
    return `${labels[segment.leg.kind]} · ${scTitle(app, segment.from)}${segment.from === segment.to ? '' : ` → ${scTitle(app, segment.to)}`}`;
}

/** Play state only (no re-render: the subtitle must not fade in again). */
export function cinePlayState(app: App): void {
    const { cine } = app;
    const b = cineOf(app).querySelector('.cn-play');
    if (b) {
        b.textContent = cine.playing ? '❚❚' : '▶';
        b.setAttribute('aria-label', `${cine.playing ? 'Pause' : 'Resume'} (Space)`);
    }
    const bar = cineOf(app).querySelector<HTMLElement>('.cn-prog .now b');
    if (bar) bar.style.animationPlayState = cine.playing ? 'running' : 'paused';
    cineOf(app).classList.toggle('paused', !cine.playing);
}

export function cineWake(app: App): void {
    const { cine } = app;
    cineOf(app).classList.remove('idle');
    cancel(app, cine.idle);
    cine.idle = later(app, () => cine.playing && cineOf(app).classList.add('idle'), 2200);
}

export function enterCinema(app: App, i = 0): void {
    const { state, scene, cine } = app;
    const sc = app.currentScenario();
    if (!sc) return;
    app.hideCard();
    app.$('#scmenu').hidden = true;
    app.clearCine();
    const already = cine.on;
    cine.on = true;
    cine.playing = scene.motion; // reduced motion: it waits on its first shot for ▶ / Space
    scene.cinema = true;
    cineOf(app).hidden = false;
    app.cineWake();
    if (state.scenario!.i !== i) app.playScenario(sc.id, i, { camera: false });
    cine.phase = i === 0 ? 'title' : 'step';
    cine.ms = 0;
    if (already) return i === 0 ? app.titleShot() : app.runStep(i);
    // a cut through black: the panel goes and the map takes the whole screen unseen, the shots start on the new size
    veil(app, true);
    app.cineAt(260, () => {
        app.host.classList.add('cinema');
        app.renderCinema();
    });
    app.cineAt(520, () => (veil(app, false), i === 0 ? app.titleShot() : app.runStep(i)));
}

export function titleShot(app: App): void {
    const { state, scene, cine } = app;
    cine.phase = 'title';
    if (state.scDeep) app.relayout(); // the whole picture under the title card
    app.renderCinema();
    scene.frameIds(app.scenarioStage(), { pad: 1.15, dur: 2200, arc: true, turn: -0.35, lift: 0.05 });
    app.cineAt(2200, () => scene.driftFor(TITLE_MS, { turn: 0.12, dolly: 0.08 }));
    app.cinePlayState();
    if (cine.playing) app.cineAt(TITLE_MS, () => app.runStep(0));
}

/** Play a step on one elapsed timeline; resuming starts inside its unfinished visible hop. */
export function runStep(app: App, i: number, { resume = false }: { resume?: boolean } = {}): void {
    const { state, scene, cine } = app;
    const sc = app.currentScenario()!;
    app.clearCine();
    scene.stopShots();
    const was = cine.phase;
    cine.phase = 'step';
    if (state.scenario!.i !== i) app.playScenario(sc.id, i, { camera: false });
    else if (state.scDeep && was !== 'step') app.relayout();
    const layout = [...state.expanded].sort().join('|');
    if (!resume || !cine.segments) {
        delete cineOf(app).dataset.key;
        cine.elapsed = 0;
        cine.segments = stepTimeline(app, i);
    } else if (cine.layout !== layout) {
        const rebuilt = stepTimeline(app, i);
        cine.elapsed = remapElapsed(cine.segments, rebuilt, cine.segment ?? 0, cine.elapsed);
        cine.segments = rebuilt;
        delete cineOf(app).dataset.key;
    }
    cine.layout = layout;
    cine.ms = cine.segments.reduce((sum, segment) => sum + segment.ms, 0);
    cine.t0 = performance.now();
    playTimeline(app, cine.elapsed);
}

function stepTimeline(app: App, i: number): CinemaSegment[] {
    const sc = app.currentScenario()!;
    const segments = segmentsFor(app, sc.flow!.legs.filter((leg) => leg.step === i));
    const travel = segments.reduce((sum, segment) => sum + segment.ms, 0);
    const last = segments.at(-1);
    if (last) segments.push({ ...last, key: undefined, hold: true, from: last.to, ms: Math.max(1400, stepSeconds(sc.steps[i]) * 1000 - travel) });
    return segments;
}

/** Preserve progress within the semantic leg when zoom changes the number of visible transport hops. */
function remapElapsed(old: CinemaSegment[], rebuilt: CinemaSegment[], index: number, elapsed: number): number {
    const active = old[index];
    const matches = (segment: CinemaSegment) => segment.hold === active.hold && Boolean(segment.frame) === Boolean(active.frame) && sameLeg(segment.leg, active.leg);
    const oldFirst = old.findIndex(matches), newFirst = rebuilt.findIndex(matches);
    const duration = (segments: CinemaSegment[]) => segments.filter(matches).reduce((sum, segment) => sum + segment.ms, 0);
    const offset = (segments: CinemaSegment[], first: number) => segments.slice(0, first).reduce((sum, segment) => sum + segment.ms, 0);
    const ratio = Math.max(0, Math.min(1, (elapsed - offset(old, oldFirst)) / duration(old)));
    return offset(rebuilt, newFirst) + ratio * duration(rebuilt);
}

function sameLeg(a: CinemaLeg, b: CinemaLeg): boolean {
    return a === b || (a.kind === b.kind && a.step === b.step && a.from === b.from && a.to === b.to && a.edge?.id === b.edge?.id);
}

/** Resolve logical identity through `members`, then order the actual gateway hops, reversed for a return. */
function segmentsFor(app: App, legs: CinemaLeg[]): CinemaSegment[] {
    const { model, state } = app;
    const vis = (id: string) => visibleAncestor(model, state.expanded, id).id;
    return legs.flatMap((leg): CinemaSegment[] => {
        const reverse = leg.kind === 'response';
        const edge = leg.edge;
        const base = { leg, reverse, from: vis(leg.from), to: vis(leg.to), ms: 1800 };
        if (!edge || leg.kind === 'attention') return [base];
        const member = `${vis(edge.from)}|${vis(edge.to)}|${edge.group}`;
        const route = [vis(edge.from), ...edge.via.map(vis), vis(edge.to)].filter((id, i, ids) => !i || id !== ids[i - 1]);
        const hops: CinemaSegment[] = [];
        let at = vis(edge.from);
        // routeVia already removes collapsed/ancestor hops; follow its members rather than reconstructing their keys.
        for (let guard = 0; guard < route.length + 2 && at !== vis(edge.to); guard++) {
            const choices = state.folded.filter((e) => e.members.includes(member) && e.raw.some((r) => r.id === edge.id) && e.from === at);
            if (choices.length !== 1) break;
            const hop = choices[0];
            hops.push({ ...base, from: hop.from, to: hop.to, key: hop.id, ms: 1700 });
            at = hop.to;
        }
        const segments: CinemaSegment[] = hops.length && at === vis(edge.to) ? hops : [base];
        if (leg.kind === 'delivery' && edge.toMethod) {
            const branches = cinemaEventFork(model, app.currentScenario()!.flow!, leg).slice(1);
            if (branches.length > 1) segments.push({ ...base, leg: { ...leg, kind: 'attention', from: edge.to, to: edge.to, edge: undefined, contract: null }, key: undefined, from: vis(edge.to), to: vis(edge.to), frame: [vis(edge.to), ...branches.map((item) => vis(item.to))], ms: 1800 });
        }
        return reverse ? segments.reverse().map((hop) => ({ ...hop, from: hop.to, to: hop.from })) : segments;
    });
}

function playTimeline(app: App, baseElapsed: number): void {
    const { cine, scene } = app;
    const segments = cine.segments!;
    let offset = 0;
    const index = segments.findIndex((segment) => {
        if (baseElapsed < offset + segment.ms) return true;
        offset += segment.ms;
        return false;
    });
    if (index < 0) {
        const i = app.state.scenario!.i;
        return i < app.currentScenario()!.steps.length - 1 ? app.runStep(i + 1) : app.endShot();
    }
    cine.segment = index;
    cine.elapsed = baseElapsed;
    cine.t0 = performance.now();
    const segment = segments[index];
    const progress = Math.max(0, (baseElapsed - offset) / segment.ms);
    const remaining = segment.ms * (1 - progress);
    app.updateView();
    app.renderCinema();
    app.cinePlayState();
    const shot = scene.shotOf(new Set([segment.from]), { pad: 2.6, shiftX: segment.leg.contract ? 0.24 : 0 });
    if (segment.key && cine.playing) {
        const from = segment.reverse ? 1 - progress : progress;
        if (!scene.trackCurve(segment.key, remaining, shot?.dist, { keep: shot?.off, from, to: segment.reverse ? 0 : 1 })) {
            scene.frameIds(new Set([segment.to]), { dur: 0, pad: 2.6, shiftX: segment.leg.contract ? 0.24 : 0 });
        }
    } else {
        scene.frameIds(new Set(segment.frame ?? [segment.to]), { dur: cine.playing ? Math.min(700, remaining) : 0, pad: segment.frame ? 1.1 : 2.6, shiftX: segment.leg.contract ? 0.24 : 0 });
    }
    if (cine.playing) app.cineAt(remaining, () => playTimeline(app, offset + segment.ms));
}

export function endShot(app: App): void {
    const { state, scene, cine } = app;
    app.clearCine();
    cine.phase = 'end';
    cine.playing = false;
    if (state.scDeep) app.relayout(); // back out to the whole picture
    app.renderCinema();
    app.cinePlayState();
    app.cineWake();
    scene.frameIds(app.scenarioStage(), { pad: 1.2, dur: 2400, arc: true, turn: 0.4, lift: 0.05 });
    app.cineAt(2400, () => scene.driftFor(12000, { turn: 0.2, dolly: 0.04 }));
}

export function pauseCinema(app: App): void {
    const { scene, cine } = app;
    if (!cine.playing) return;
    app.clearCine();
    scene.stopShots({ keepComet: true });
    if (cine.phase === 'step') cine.elapsed += performance.now() - cine.t0;
    cine.playing = false;
    app.cinePlayState();
    app.cineWake();
}

export function resumeCinema(app: App): void {
    const { state, cine } = app;
    if (cine.phase === 'end') return app.enterCinema(0);
    cine.playing = true;
    app.cineWake();
    if (cine.phase === 'title') return app.titleShot();
    app.runStep(state.scenario!.i, { resume: cine.elapsed > 0 });
}

/** ← → or a step on the progress line: that step's shots; it plays on if the cinema plays. */
export function cineGo(app: App, i: number): void {
    const { cine } = app;
    const sc = app.currentScenario();
    if (!sc) return;
    i = Math.max(0, Math.min(sc.steps.length - 1, i));
    cine.elapsed = 0;
    if (cine.phase === 'end') cine.playing = true;
    app.runStep(i);
}

export function exitCinema(app: App): void {
    const { state, scene, cine } = app;
    if (!cine.on) return;
    app.clearCine();
    cancel(app, cine.idle);
    scene.stopShots();
    cine.on = cine.playing = false;
    scene.cinema = false;
    if (isFullscreen(app.host)) document.exitFullscreen?.().catch(() => {});
    veil(app, true);
    app.cineAt(260, () => {
        app.host.classList.remove('cinema');
        app.$('#stage').classList.remove('cn-titlecard');
        cineOf(app).hidden = true;
        cineOf(app).innerHTML = '';
        if (state.scDeep && state.scenario) app.relayout(); // the end card stood on the whole picture: back to the step's level
        else scene.applyView();
        veil(app, false);
        if (state.scenario) app.stepCamera(); // back with the panel: the step framed on the smaller map
    });
}

/** Full screen is the map's host (the page around it stays as it is). */
export function toggleFullscreen(app: App): void {
    if (isFullscreen(app.host)) document.exitFullscreen?.().catch(() => {});
    else app.host.requestFullscreen?.().catch(() => {});
}

/** Read-only playback cursor for browser regressions and inspection. */
export function cinemaState(app: App): CinemaPlayback {
    const { cine, state, scene } = app;
    return {
        on: cine.on, playing: cine.playing, phase: cine.phase,
        step: state.scenario ? state.scenario.i + 1 : null, ms: cine.ms,
        elapsed: cine.elapsed + (cine.playing && cine.phase === 'step' ? performance.now() - cine.t0 : 0),
        segment: cine.segment, leg: cine.segments?.[cine.segment ?? 0], journey: app.currentScenario()?.flow?.legs,
        track: scene.track ? { from: scene.track.from, to: scene.track.to, progress: Math.min(1, (performance.now() - scene.track.t0) / scene.track.dur) } : null,
    };
}
