// What is lit and what is shown on the map: the blocks and relations a selection or hover lights, the step of a scenario, the
// envelopes (chips) on relations, the metric coloring. Computes the scene's `SceneView` from the app state.
import { cinemaEventFork } from './cinema-flow.ts';
import { ancestors, inside, visibleAncestor } from './model.ts';
import { metric as nodeMetric, metricTints } from './metrics.ts';
import { contractEnvelopes, edgesEnvelopes, chipsOf, edgesWith } from './envelopes.ts';
import { tierOf } from './core/tier.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { Chip, EnvelopeSides, ScenarioStep, ViewNode } from '../../types/viewer.ts';
import type { Hit } from '../../types/scene.ts';
import type { App } from './app.ts';

/** a drawn line is on the current scenario step when it carries one of the step's relations (routed lines carry many) */
export function onStepLine(app: App, e: { id: string; members?: string[] }): boolean {
    const { state } = app;
    return !!state.step && (e.members ?? [e.id]).some((k) => state.step!.keys.has(k));
}

export function neighbours(app: App, hit: Hit | null): { nodes: Set<ElementId>; edges: Set<string> } | null {
    const { state, model } = app;
    if (!hit) return null;
    const withAnc = (set: Set<ElementId>, id: ElementId) => (set.add(id), ancestors(model, id).forEach((a) => set.add(a.id)));
    if (hit.type === 'envelope') {
        // the same object (one schema reference) wherever it travels on the map
        const nodes = new Set<ElementId>(), edges = new Set<string>();
        const onStep = stepCarries(app, hit.id);
        for (const e of state.folded) if (edgesWith(e.raw, hit.id).length || (onStep && onStepLine(app, e))) {
            edges.add(e.id);
            withAnc(nodes, e.from);
            withAnc(nodes, e.to);
        }
        return { nodes, edges };
    }
    if (hit.type === 'edge') {
        const e = state.foldedById.get(hit.id);
        if (!e) return null;
        const nodes = new Set<ElementId>();
        withAnc(nodes, e.from);
        withAnc(nodes, e.to);
        return { nodes, edges: new Set([e.id]) };
    }
    const nodes = new Set<ElementId>();
    withAnc(nodes, hit.id);
    const edges = new Set<string>();
    // a line lights when it carries a relation of this block — the whole route, through the gateway and the API
    for (const e of state.folded) if (inside(model, e.from, hit.id) || inside(model, e.to, hit.id) || e.raw.some((r) => inside(model, r.from, hit.id) || inside(model, r.to, hit.id))) {
        edges.add(e.id);
        withAnc(nodes, e.from);
        withAnc(nodes, e.to);
    }
    for (const id of state.placedIds) if (inside(model, id, hit.id)) nodes.add(id);
    return { nodes, edges };
}

/** the ui-tier app a node is in (itself or an ancestor), else null */
export function uiApp(app: App, id: ElementId): ElementId | null {
    const { model } = app;
    const n = model.nodes.get(id);
    const appNode = n && [n, ...ancestors(model, id)].find((a) => a.type === 'app');
    return appNode && tierOf(model.merged, appNode.id) === 'ui' ? appNode.id : null;
}

/** What the scene's view is made of, built up by the parts of `updateView`: the path or the focus, the scenario step, the selection. */
interface ViewDraft {
    keep: Set<ElementId> | null;
    steps: Map<ElementId, string | number> | null;
    litEdges: Set<string> | null;
    lit: Set<ElementId> | null;
    soft: boolean;
    edgeSteps: Map<string, number> | null;
    bridge: Set<string> | null;
}

export function updateView(app: App): void {
    const { state, scene } = app;
    const d: ViewDraft = { keep: null, steps: null, litEdges: null, lit: null, soft: false, edgeSteps: null, bridge: null };
    if (state.path) pathDraft(app, d);
    else if (state.focus) focusDraft(app, d);
    // a scenario step lights its blocks and relations (softly: the picture around it stays readable)
    if (state.step && !state.path) stepDraft(app, d);
    const sel = selectionDraft(app, d);
    scene.selected = state.selected?.type === 'envelope' ? null : state.selected?.id ?? null;
    scene.pulsesOn = state.pulses;
    scene.setView({ keep: d.keep, edges: null, lit: d.lit, litEdges: d.litEdges, bridge: sel ? null : d.bridge, focus: state.focus, steps: d.steps, edgeSteps: d.edgeSteps, soft: d.soft, tint: tintMap(app), env: envelopesView(app, sel ? null : d.edgeSteps) });
}

/** A path: its blocks (and their parents) are kept, numbered; the lines are the path's. */
function pathDraft(app: App, d: ViewDraft): void {
    const { state, model } = app;
    const keep = (d.keep = new Set<ElementId>());
    const steps = (d.steps = new Map<ElementId, string | number>());
    const mark = (id: ElementId, no?: string | number) => {
        const vis = visibleAncestor(model, state.expanded, id).id;
        keep.add(vis);
        ancestors(model, vis).forEach((a) => keep.add(a.id));
        if (no !== undefined && !steps.has(vis)) steps.set(vis, no);
    };
    mark(state.path!.start, '▶');
    state.path!.steps.forEach((s, i) => (mark(s.from), mark(s.to, i + 1)));
    d.litEdges = new Set(state.folded.map((e) => e.id));
}

/** A focus: it, its parents, what is inside it and what its relations reach are kept; the rest is ghosts. */
function focusDraft(app: App, d: ViewDraft): void {
    const { state, model } = app;
    const keep = (d.keep = new Set([state.focus!, ...ancestors(model, state.focus!).map((a) => a.id)]));
    for (const id of state.placedIds) if (inside(model, id, state.focus!)) keep.add(id);
    for (const e of state.folded)
        for (const id of [e.from, e.to]) {
            keep.add(id);
            ancestors(model, id).forEach((a) => keep.add(a.id));
        }
}

/** A scenario step lights its blocks and relations, numbers the relation (or, with none of its own, the blocks), and shows the way from the last step. */
function stepDraft(app: App, d: ViewDraft): void {
    const { state, model } = app;
    const step = state.step!;
    const no = state.scenario!.i + 1;
    d.soft = true;
    const lit = (d.lit = new Set<ElementId>());
    for (const id of [...step.nodes, ...step.bridge.nodes]) {
        lit.add(id);
        ancestors(model, id).forEach((a) => lit.add(a.id));
    }
    const litEdges = (d.litEdges = new Set(state.folded.filter((e) => onStepLine(app, e)).map((e) => e.id)));
    if (app.cine.on) retainEventFork(app, lit, litEdges);
    d.bridge = new Set(step.bridge.keys.filter((k) => state.foldedById.has(k) && !litEdges.has(k)));
    d.steps = new Map();
    d.edgeSteps = new Map([...litEdges].map((id) => [id, no]));
    // the number goes on the relation; a step with no line of its own numbers its blocks
    if (!litEdges.size) for (const id of step.nodes) d.steps.set(id, no);
}

function retainEventFork(app: App, lit: Set<ElementId>, litEdges: Set<string>): void {
    const active = app.cine.segments?.[app.cine.segment ?? 0]?.leg;
    const flow = app.currentScenario()?.flow;
    const deliveries = active && flow ? cinemaEventFork(app.model, flow, active) : [];
    const edges = new Set(deliveries.map((leg) => leg.edge?.id));
    for (const leg of deliveries) for (const id of [leg.from, leg.to]) {
        const visible = visibleAncestor(app.model, app.state.expanded, id).id;
        lit.add(visible);
        ancestors(app.model, visible).forEach((node) => lit.add(node.id));
    }
    for (const edge of app.state.folded) if (edge.raw.some((raw) => edges.has(raw.id))) litEdges.add(edge.id);
    const fork = app.cine.segments?.[app.cine.segment ?? 0]?.frame;
    if (fork) {
        lit.clear();
        fork.forEach((id) => lit.add(id));
    }
}

function cinemaSide(app: App): 'request' | 'response' | null {
    const kind = app.cine.segments?.[app.cine.segment ?? 0]?.leg.kind;
    if (kind === 'response') return 'response';
    return kind === 'request' || kind === 'delivery' ? 'request' : null;
}

/** A selection dims the rest (returned: what it lights); a hover only brings out its relations. */
function selectionDraft(app: App, d: ViewDraft): ReturnType<typeof neighbours> {
    const { state } = app;
    // a chosen envelope shows where it travels even while a scenario plays
    const envSel = state.selected?.type === 'envelope';
    // the focus selected on entering is «here», not a choice inside the picture: its panel shows, its lines stay as the
    // focus draws them (lighting every line of a dense focus would light all of them)
    const selIsFocus = state.selected?.type === 'node' && state.selected.id === state.focus;
    const sel = state.path || (d.soft && !envSel) || selIsFocus ? null : neighbours(app, state.selected);
    if (sel) {
        d.lit = sel.nodes;
        d.litEdges = sel.edges;
        d.soft = false;
    }
    // the cursor resting on the focus board itself (it is there after the wheel opened it) lights nothing either
    const hov = !sel && !d.soft && !state.path && state.hover?.type === 'node' && state.hover.id !== state.focus ? neighbours(app, state.hover) : null;
    if (hov) d.litEdges = hov.edges;
    return sel;
}

export function currentStep(app: App): ScenarioStep | null {
    const { state } = app;
    return state.step && !state.path ? app.currentScenario()?.steps[state.scenario!.i] ?? null : null;
}

/** The current scenario step names this object in its own contract (a step-level contract is on no relation). */
export function stepCarries(app: App, key: string): boolean {
    const c = currentStep(app)?.contract;
    return !!c && (['request', 'response'] as const).some((s) => c[s] && `${c.doc}${c[s]}` === key);
}

/**
 * Where envelopes are shown: never at rest — only on the relations of the current scenario step (the step's own
 * object), on the selected and the hovered relation (every object that travels on it), and, when an envelope is chosen,
 * on every relation that carries it (that object only). Folded edge id → chips.
 */
export function envelopesView(app: App, edgeSteps: Map<string, number> | null): Map<string, Chip[]> {
    const { state, envCtx } = app;
    if (app.cine.on) return cinemaEnvelopes(app);
    const out = new Map<string, Chip[]>();
    const put = (id: string, sides: EnvelopeSides, only: string | null = null) => {
        const chips = chipsOf(sides, only);
        if (chips.length && !out.has(id)) out.set(id, chips);
    };
    if (state.selected?.type === 'envelope') {
        const key = state.selected.id;
        if (stepCarries(app, key)) for (const e of state.folded) if (onStepLine(app, e)) put(e.id, contractEnvelopes(envCtx, currentStep(app)!.contract), key);
        for (const e of state.folded) if (edgesWith(e.raw, key).length) put(e.id, edgesEnvelopes(envCtx, e.raw), key);
    }
    if (edgeSteps?.size) {
        const step = app.currentScenario()!.steps[state.scenario!.i];
        const mine = new Set(step.edges.map((e) => e.id));
        for (const id of edgeSteps.keys()) {
            const e = state.foldedById.get(id);
            if (e) put(id, step.contract ? contractEnvelopes(envCtx, step.contract) : edgesEnvelopes(envCtx, e.raw.filter((r) => mine.has(r.id))));
        }
    }
    for (const hit of [state.selected, state.hover])
        if (hit?.type === 'edge' && state.foldedById.has(hit.id)) put(hit.id, edgesEnvelopes(envCtx, state.foldedById.get(hit.id)!.raw));
    return out;
}

/** Cinema payloads belong to the active leg, including returns inserted before another authored step. */
function cinemaEnvelopes(app: App): Map<string, Chip[]> {
    const out = new Map<string, Chip[]>();
    const segment = app.cine.segments?.[app.cine.segment ?? 0];
    const leg = segment?.leg;
    if (!leg?.edge) return out;
    const chips = chipsOf(contractEnvelopes(app.envCtx, leg.contract)).filter((chip) => chip.side === cinemaSide(app));
    for (const edge of app.state.folded) if (edge.raw.some((raw) => raw.id === leg.edge!.id) && chips.length) out.set(edge.id, chips);
    return out;
}

// ---------- metric coloring ----------
export const METRICS: Record<string, { title: string; hint?: string }> = {
    kind: { title: 'By kind' },
    coupling: { title: 'Coupling', hint: 'relations across the block boundary' },
    api: { title: 'API', hint: 'endpoints inside' },
    db: { title: 'Database', hint: 'table accesses' },
};

export const metric = (app: App, n: ViewNode, kind: string): number => nodeMetric(app.model, n, kind);

export function tintMap(app: App): Map<ElementId, number> | null {
    return metricTints(app.model, app.state.placed, app.state.tint);
}
