// Scenario playback (AD-8): the steps of a client-layer scenario, resolved by core/resolve.js, shown on whatever the
// map has open right now. A step never opens or closes anything: zooming in during a scenario shows the same step in
// more detail, and ← / → continue from it. Pure helpers (no DOM, no three.js) plus the HTML of the picker, the step bar
// and the panel; main.js wires them.
import { planCinema } from './cinema-flow.ts';
import { resolveScenarios } from './core/resolve.ts';
import { ancestors, visibleAncestor, kindGroup } from './model.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { Bridge, BridgeOut, Model, ScenarioStep, SideShape, StepView, ViewEdge, ViewScenario } from '../../types/viewer.ts';

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Scenarios of the loaded specs with view ids: steps that do not resolve (a `?docs=` subset) are dropped.
 * Step: { caption, kind: 'element'|'edge', element?, from?, to?, contract?, edges: [adapter edges] } (`contract`: the
 * step's own, else the first effective one among its edges — what the step's envelopes show).
 */
export function scenariosOf(model: Model): ViewScenario[] {
    const byId = new Map(model.edges.map((e) => [e.id, e]));
    const has = (id: ElementId) => model.nodes.has(model.nodeOf(id));
    return resolveScenarios(model.merged)
        .scenarios.map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description ?? '',
            steps: s.resolved
                .filter((r) => !r.missing.length && (r.kind === 'element' ? has(r.element) : has(r.from) && has(r.to)))
                .map((r): ScenarioStep =>
                    r.kind === 'element'
                        ? { caption: r.caption, duration: r.duration, kind: 'element', element: model.nodeOf(r.element), edges: [] }
                        : { caption: r.caption, duration: r.duration, kind: 'edge', from: model.nodeOf(r.from), to: model.nodeOf(r.to), channel: r.channel, contract: r.contract, edges: r.edges.map((e) => byId.get(e.id)).filter((e): e is ViewEdge => Boolean(e)) },
                ),
        }))
        .filter((s) => s.steps.length)
        .map((s) => {
            const flow = planCinema(model, s.steps);
            s.steps.forEach((st, i) => {
                st.journey = flow.legs.filter((leg) => leg.step === i);
                st.bridge = i ? bridgeOf(model, s.steps, i) : null;
            });
            return { ...s, flow };
        });
}

/** Relation kinds a bridge may follow: calls inside an app, in-process events, a front-end module importing another. */
const BRIDGE_KINDS = new Set(['call', 'event', 'import']);
const BRIDGE_DEPTH = 5;
const stepEnds = (st: ScenarioStep): ElementId[] => (st.kind === 'element' ? [st.element] : [st.to, st.from]);
const stepStart = (st: ScenarioStep): ElementId => (st.kind === 'element' ? st.element : st.from);

/**
 * The bridge into step `i`: how the flow gets from the previous steps to where step `i` starts — the shortest chain of
 * calls, events or imports (at most BRIDGE_DEPTH hops) from the ends of step i-1, else of the step before it (a call
 * returns to its caller, which goes on: «the service checked the slots, then saved the registration»), up to 3 back.
 * { nodes: [ids, the last is where step i starts], edges: [model edges in order] }, or null (no chain, or nothing to
 * bridge: the step starts where the last one ended).
 */
export function bridgeOf(model: Model, steps: ScenarioStep[], i: number): Bridge | null {
    model._bridgeOut ??= (() => {
        const out: BridgeOut = new Map();
        for (const e of model.edges) {
            if (!BRIDGE_KINDS.has(e.kind)) continue;
            const a = model.nodeOf(e.from), b = model.nodeOf(e.to);
            if (a !== b) (out.get(a) ?? out.set(a, []).get(a)!).push({ to: b, e });
        }
        return out;
    })();
    const dst = stepStart(steps[i]);
    for (let back = 1; back <= 3 && i - back >= 0; back++) {
        const src = stepEnds(steps[i - back]);
        if (back === 1 && src.includes(dst)) return null;
        const prev = new Map<ElementId, { from: ElementId; e: ViewEdge } | null>(src.map((n) => [n, null]));
        let q = [...src];
        for (let d = 0; d < BRIDGE_DEPTH && q.length && !prev.has(dst); d++) {
            const next: ElementId[] = [];
            for (const n of q) for (const { to, e } of model._bridgeOut.get(n) ?? []) if (!prev.has(to)) {
                prev.set(to, { from: n, e });
                next.push(to);
            }
            q = next;
        }
        if (!prev.has(dst) || prev.get(dst) === null) continue;
        const nodes: ElementId[] = [], edges: ViewEdge[] = [];
        for (let n = dst; prev.get(n); n = prev.get(n)!.from) {
            nodes.unshift(n);
            edges.unshift(prev.get(n)!.e);
        }
        nodes.unshift(prev.get(nodes[0])!.from);
        return { nodes, edges };
    }
    return null;
}

/**
 * What a step lights at the current expansion: the visible blocks it touches, and the keys (`from|to|group`, as
 * model.js foldEdges builds them) of the folded relations it runs along. Relations folded inside one block have no
 * line: that block is lit instead.
 */
export function stepView(model: Model, expanded: Set<ElementId>, step: ScenarioStep, cinema = false): StepView {
    if (cinema) return cinemaStepView(model, expanded, step);
    const nodes = new Set<ElementId>();
    const keys = new Set<string>();
    const vis = (id: ElementId) => visibleAncestor(model, expanded, id);
    if (step.kind === 'element') nodes.add(vis(step.element).id);
    else {
        for (const e of step.edges) {
            const a = vis(e.from), b = vis(e.to);
            nodes.add(a.id).add(b.id);
            if (a === b || ancestors(model, b.id).includes(a) || ancestors(model, a.id).includes(b)) continue;
            keys.add(`${a.id}|${b.id}|${e.group}`);
        }
        if (!step.edges.length) nodes.add(vis(step.from).id).add(vis(step.to).id);
    }
    // the bridge from the previous step, at this expansion: its visible blocks, and its relations in order (a hop
    // folded inside one block has no line)
    const bridge: StepView['bridge'] = { nodes: new Set(), keys: [] };
    for (const id of step.bridge?.nodes ?? []) bridge.nodes.add(vis(id).id);
    for (const e of step.bridge?.edges ?? []) {
        const a = vis(model.nodeOf(e.from)), b = vis(model.nodeOf(e.to));
        if (a === b || ancestors(model, b.id).includes(a) || ancestors(model, a.id).includes(b)) continue;
        const key = `${a.id}|${b.id}|${kindGroup(e.kind)}`;
        if (bridge.keys.at(-1) !== key) bridge.keys.push(key);
    }
    return { nodes, keys, bridge };
}

function cinemaStepView(model: Model, expanded: Set<ElementId>, step: ScenarioStep): StepView {
    const nodes = new Set<ElementId>(), keys = new Set<string>();
    const vis = (id: ElementId) => visibleAncestor(model, expanded, id);
    for (const leg of step.journey ?? []) {
        nodes.add(vis(leg.from).id).add(vis(leg.to).id);
        if (!leg.edge) continue;
        for (const id of leg.edge.via) nodes.add(vis(id).id);
        const a = vis(leg.edge.from), b = vis(leg.edge.to);
        if (a === b || ancestors(model, b.id).includes(a) || ancestors(model, a.id).includes(b)) continue;
        keys.add(`${a.id}|${b.id}|${leg.edge.group}`);
    }
    return { nodes, keys, bridge: { nodes: new Set(), keys: [] } };
}

/**
 * Seconds a step is read in the cinema: the spec's `duration` if it has one, else by the caption — about 18 characters a
 * second on top of 3 s to find the place, between 5 and 10 s.
 */
export const stepSeconds = (step: Pick<ScenarioStep, 'duration' | 'caption'>): number => step.duration ?? Math.min(10, Math.max(5, 3 + step.caption.length / 18));

export const pickerHtml = (list: ViewScenario[], current: string | null | undefined): string =>
    list
        .map(
            (s) => `<button class="sc-item" data-scenario="${esc(s.id)}" data-open="1" aria-pressed="${s.id === current}">
          <b>${esc(s.title)}</b><span>${s.steps.length} steps${s.description ? ` · ${esc(s.description)}` : ''}</span></button>`,
        )
        .join('') + '<div class="sc-hint"><kbd>Space</kbd> cinema · <kbd>←</kbd> <kbd>→</kbd> step · <kbd>?</kbd> all shortcuts</div>';

/** What the Scenarios menu holds on a map without a scenario: they are written by hand, not derived from the code. */
export const noScenariosHtml = (): string =>
    `<div class="sc-none"><b>No scenarios in this project</b><span>A scenario is a short walk through the map (steps, each naming a block or a relation), written by hand in a client-layer spec under <code>scenarios</code>. The format is in specs/README.md, “Client layer”.</span></div>`;

/** The bar over the map: «Step n/N — caption», back / forward, watch (the cinema), the camera following steps, close. */
export function stepbarHtml(s: ViewScenario, i: number, { camera = true, deep = true }: { camera?: boolean; deep?: boolean } = {}): string {
    const step = s.steps[i];
    const dots = s.steps.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'past' : ''}" data-goto="${k}" title="Step ${k + 1}"></i>`).join('');
    return `<div class="sb-head"><span class="sb-title">${esc(s.title)}</span><span class="sb-dots" aria-hidden="true">${dots}</span>
        <button class="sb-cam" data-scdeep="1" aria-pressed="${deep}" title="Open the blocks a step happens in and show it on its own components">⤵ Go inside</button>
        <button class="sb-cam" data-sccam="1" aria-pressed="${camera}" title="The camera shows every step">◎ Camera follows steps</button>
        <button class="sb-close" data-scclose="1" title="Close (Esc)" aria-label="Close the scenario">✕</button></div>
      <div class="sb-row">
        <button class="sb-watch" data-cinema="${i}" title="Play from this step (Space)">▶ Watch</button>
        <button class="sb-nav" data-scstep="-1" ${i === 0 ? 'disabled' : ''} aria-label="Previous step (←)">‹</button>
        <div class="sb-text"><span class="sb-no">Step ${i + 1}/${s.steps.length}</span><span class="sb-cap">${esc(step.caption)}</span></div>
        <button class="sb-nav" data-scstep="1" ${i === s.steps.length - 1 ? 'disabled' : ''} aria-label="Next step (→)">›</button>
      </div>`;
}

/** The panel while a scenario plays and nothing is selected: what the current step sends, all steps, the current one marked. */
export function scenarioPanelHtml(s: ViewScenario, i: number, title: (id: ElementId) => string, contract = ''): string {
    return `<header class="ph"><div class="kind">scenario</div><h3>${esc(s.title)}</h3>${s.description ? `<p class="desc">${esc(s.description)}</p>` : ''}</header>
      ${contract ? `<section><h4>Step ${i + 1} contract</h4><div class="sc-contract">${contract}</div></section>` : ''}
      <section><h4>Steps <span class="count">${s.steps.length}</span></h4><ol class="sc-steps">${s.steps
          .map(
              (st, k) => `<li><button data-goto="${k}" ${k === i ? 'aria-current="true"' : ''}><span class="no">${k + 1}</span><span class="cap">${esc(st.caption)}</span>
              <span class="who">${esc(st.kind === 'element' ? title(st.element) : `${title(st.from)} → ${title(st.to)}`)}</span>${st.bridge ? `<span class="via">↳ via ${esc(st.bridge.nodes.map(title).join(' → '))}</span>` : ''}</button></li>`,
          )
          .join('')}</ol></section>
      <section><ul class="plain help"><li><b>Space</b> or “▶ Watch” plays it: the camera takes you through the steps. <b>← →</b> change the step, <b>Esc</b> closes.</li><li>Zoom into a step with the wheel to see it in detail: the scenario continues from the same step.</li></ul></section>`;
}

/**
 * What a step sends, as code-like cards: per side (request, response) the object's name and schema, then its fields —
 * name (* = required), contract type, the client layer's label — and for an object field its own first fields. `route`:
 * «from → to» under the request, reversed under the response. Empty when the step has no contract.
 */
export function contractHtml(shapes: SideShape[] | null | undefined, { from = '', to = '' }: { from?: string; to?: string } = {}): string {
    if (!shapes?.length) return '';
    const card = ({ side, shape }: SideShape) => {
        const rows = shape.fields
            .map(
                (f) => `<div class="ct-f"><code class="ct-n">${esc(f.name)}${f.required ? '<i title="required">*</i>' : ''}</code><code class="ct-t">${esc(f.type || '—')}</code><span class="ct-l">${esc(f.label)}</span></div>` +
                    (f.children.length
                        ? `<div class="ct-sub"><code>{ ${f.children.map((c) => `${esc(c.name)}${c.required ? '' : '?'}: ${esc(c.type || 'any')}`).join(', ')}${f.childMore ? `, … ${f.childMore} more` : ''} }</code></div>`
                        : ''),
            )
            .join('');
        const route = side === 'request' ? `${from} → ${to}` : `${to} → ${from}`;
        return `<section class="ct ${side}"><header><span class="ct-side">${side === 'request' ? 'sends' : 'returns'}</span><b>${esc(shape.title)}</b><code class="ct-schema">${esc(shape.schemaName)}</code></header>
          ${from && to ? `<div class="ct-route">${esc(route)}</div>` : ''}
          <div class="ct-body"><code class="ct-brace">{</code>${rows}${shape.more ? `<div class="ct-more">… ${shape.more} more ${shape.more === 1 ? 'field' : 'fields'}</div>` : ''}<code class="ct-brace">}</code></div>
          ${shape.loaded ? '' : `<div class="ct-more">${shape.pending ? 'loading the contract…' : 'the contract document is not loaded'}</div>`}</section>`;
    };
    return shapes.map(card).join('');
}

const who = (step: ScenarioStep, title: (id: ElementId) => string): string => (step.kind === 'element' ? title(step.element) : `${title(step.from)} → ${title(step.to)}`);

const journeyLabel = (journey: string | undefined, step: ScenarioStep, title: (id: ElementId) => string): string => journey || who(step, title);

/**
 * The cinema overlay: letterbox bars, the title card, the subtitle of the step (number, caption, who talks to whom), a
 * progress line per step, and the controls that show while the pointer moves. `phase`: 'title' | 'step' | 'end'.
 */
export function cinemaHtml(
    s: ViewScenario,
    i: number,
    { phase, playing, stepMs = 0, elapsed = 0, title, contract = '', journey }: { phase: 'title' | 'step' | 'end'; playing: boolean; stepMs?: number; elapsed?: number; title: (id: ElementId) => string; contract?: string; journey?: string },
): string {
    const step = s.steps[i];
    const bars = s.steps
        .map((_, k) => {
            const fill = k < i || phase === 'end' ? 'done' : k === i && phase === 'step' ? 'now' : '';
            const anim = fill === 'now' ? ` data-style="animation-duration:${Math.round(stepMs)}ms;animation-delay:-${Math.round(elapsed)}ms;animation-play-state:${playing ? 'running' : 'paused'}"` : '';
            return `<i class="${fill}" data-cgoto="${k}" title="Step ${k + 1}"><b${anim}></b></i>`;
        })
        .join('');
    const card =
        phase === 'title'
            ? `<div class="cn-card in"><span class="cn-kicker">Scenario · ${s.steps.length} steps</span><h2>${esc(s.title)}</h2>${s.description ? `<p>${esc(s.description)}</p>` : ''}</div>`
            : phase === 'end'
              ? `<div class="cn-card in"><span class="cn-kicker">End of the scenario</span><h2>${esc(s.title)}</h2><div class="cn-actions"><button data-cinema="0">↻ Watch again</button><button data-cexit="1">Exit</button></div></div>`
              : '';
    const sub =
        phase === 'step'
            ? `<div class="cn-sub" data-key="${i}"><span class="cn-no">Step ${i + 1} of ${s.steps.length}</span><span class="cn-cap">${esc(step.caption)}</span><span class="cn-who">${esc(journeyLabel(journey, step, title))}</span></div>`
            : '';
    return `<div class="cn-bar cn-top"><span class="cn-title">${esc(s.title)}</span></div>
      <div class="cn-bar cn-bottom">${sub}<div class="cn-prog">${bars}</div></div>${card}
      ${phase === 'step' ? `<aside class="cn-contract" data-key="${i}">${contract}</aside>` : ''}
      <div class="cn-ctrl">
        <button data-cstep="-1" ${i === 0 && phase !== 'end' ? 'disabled' : ''} aria-label="Previous step (←)">‹</button>
        <button class="cn-play" data-cplay="1" aria-label="${playing ? 'Pause' : 'Resume'} (Space)">${playing ? '❚❚' : '▶'}</button>
        <button data-cstep="1" ${phase === 'end' ? 'disabled' : ''} aria-label="Next step (→)">›</button>
        <button data-cfull="1" aria-label="Full screen (F)">⛶</button>
        <button data-cexit="1" aria-label="Exit (Esc)">✕</button>
      </div>`;
}
