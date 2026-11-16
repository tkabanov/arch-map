// The model as a tree: which nodes are visible for the current expansion, and relations folded up to them.

import { tiersOf } from './core/tier.ts';
import { trace as coreTrace, traceNode as coreTraceNode } from './core/path.ts';
import { summary as coreSummary } from './core/queries.ts';
import { GROUP_OF } from './spec-adapter.ts';
import { ink, type ThemeMode } from './theme.ts';
import type { Channel, ElementId, MethodName } from '../../types/spec.d.ts';
import type { SummaryEntry } from '../../types/core.ts';
import type { FoldedEdge, Model, RawModel, RoutedEdge, SearchHit, ViewEdge, ViewNode, ViewStep } from '../../types/viewer.ts';
import type { PathStep } from '../../types/core.ts';

export type Kinds = Record<string, { title: string; color: string; on: boolean }>;
/** Legend groups of relations (AD-12): color (the dark look's), label and whether the filter is on by default. Never mutated: each map has its own copy for its theme (`kindsFor`). */
export const KINDS: Kinds = {
    rest: { title: 'REST', color: '#7cc4ff', on: true },
    data: { title: 'SQL', color: '#34d399', on: true },
    event: { title: 'Events', color: '#fbbf77', on: true },
    ext: { title: 'Webhook / HTTPS / SMTP', color: '#fb7185', on: true },
    interacts: { title: 'Usage', color: '#fcd34d', on: true },
    call: { title: 'Calls', color: '#94a3b8', on: false }, // shown inside a focus anyway
    import: { title: 'Front-end imports', color: '#9fb0c8', on: false },
    references: { title: 'Foreign keys', color: '#5eead4', on: false },
};
/** A map's own copy of KINDS with the colors as they read on its theme (light: deepened, theme.ts `ink`). */
export const kindsFor = (mode: ThemeMode): Kinds => Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { ...v, color: ink(v.color, mode) }]));
export const kindGroup = (kind: string): string => GROUP_OF[kind as Channel] ?? 'call';

/** Siblings on a board: outside the slice last; then by `order` (spec 1.4; those without one follow), then by name. */
export const siblingOrder = (a: ViewNode, b: ViewNode): number =>
    Number(!!a.context) - Number(!!b.context) || (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title);

/** Endpoints on a block and all its descendants. */
export const countEndpoints = (n: ViewNode): number => (n.endpoints?.length ?? 0) + n.children.reduce((a, c) => a + countEndpoints(c), 0);

/** Whether a container has executable components among its descendants. */
export const holdsLogic = (n: ViewNode): boolean => n.children.some((c) => c.type === 'component' || holdsLogic(c));

/**
 * Raw model from spec-adapter.js → the tree the map works on. Children of a parent that are outside the slice
 * (`context`) go into a synthetic «Outside the slice» group under it, so the slice reads first.
 * `tech`: what the technical overview (`#v=tech`) opens — every system, every service-tier app, and every datastore that holds
 * logic of its own (a component inside: functions of the database). The client layer (default) opens nothing (AD-11).
 */
export function buildModel(raw: RawModel): Model {
    // leafCount and degree are set below, once the tree is built
    const nodes = new Map<ElementId, ViewNode>(raw.nodes.map((n) => [n.id, { ...n, children: [] } as unknown as ViewNode]));
    const ctxParents = new Set([...nodes.values()].filter((n) => n.context && n.parent && nodes.has(n.parent)).map((n) => n.parent!));
    for (const pid of ctxParents) {
        const p = nodes.get(pid)!;
        const id = `${pid}.__context`;
        nodes.set(id, { id, parent: pid, layer: p.layer, type: 'group', shape: 'matrix', role: 'group', context: true, title: 'Outside the slice', description: 'Elements outside the slice that it is connected to.', endpoints: [], children: [] } as unknown as ViewNode);
    }
    // `has(null)` is false: a root is never a context parent
    for (const n of nodes.values()) if (n.context && n.type !== 'group' && ctxParents.has(n.parent as ElementId)) n.parent = `${n.parent}.__context`;
    for (const n of nodes.values()) if (n.parent) nodes.get(n.parent)?.children.push(n);
    for (const n of nodes.values()) n.children.sort(siblingOrder);
    const roots = [...nodes.values()].filter((n) => !n.parent);

    const edges = raw.edges;
    const degree = new Map<ElementId, number>();
    for (const e of edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const count = (n: ViewNode): number => (n.children.length ? n.children.reduce((s, c) => s + count(c), 0) : 1);
    for (const n of nodes.values()) {
        n.leafCount = count(n);
        n.degree = degree.get(n.id) ?? 0;
    }
    const opens = (n: ViewNode): boolean => n.type === 'system' || (n.type === 'app' && n.layer === 'service') || (n.type === 'datastore' && holdsLogic(n));
    const tech = new Set([...nodes.values()].filter((n) => n.children.length && opens(n)).map((n) => n.id));
    // the layers of the map, top-down: the merged set's tiers (core/tier.js; a document may declare its own)
    return { meta: raw.meta, nodes, roots, edges, tech, tiers: tiersOf(raw.merged), merged: raw.merged, nodeOf: raw.nodeOf };
}

/**
 * Pass-through (AD-11): expanding a node with exactly one child also expands that child, so «Website» opens straight
 * into its areas. Adds the chain to `set` in place and returns it.
 */
export function passThrough(model: Model, set: Set<ElementId>): Set<ElementId> {
    for (const id of [...set]) {
        let n = model.nodes.get(id);
        while (n && n.children.length === 1 && n.children[0].children.length) {
            n = n.children[0];
            set.add(n.id);
        }
    }
    return set;
}

/** The focus that stands for a node: the outermost of a single-child chain (a single app inside a system focuses that system). */
export function focusOf(model: Model, id: ElementId): ElementId | null {
    let n = model.nodes.get(id);
    for (let p = n && model.nodes.get(n.parent!); p && p.children.length === 1; p = model.nodes.get(p.parent!)) n = p;
    return n?.id ?? null;
}

export const ancestors = (model: Model, id: ElementId): ViewNode[] => {
    const out: ViewNode[] = [];
    let n = model.nodes.get(id);
    while (n?.parent) {
        n = model.nodes.get(n.parent);
        out.push(n!); // merge rejects an unknown parent, so a parent id is a node of the model
    }
    return out;
};

/** The node itself if all its ancestors are expanded, else the topmost collapsed ancestor that is visible. */
export function visibleAncestor(model: Model, expanded: Set<ElementId>, id: ElementId): ViewNode {
    // TODO(types): an id not in the model gives `undefined` here (callers check `?.`); typed as the found node
    const chain = [model.nodes.get(id)!, ...ancestors(model, id)].reverse(); // root … node
    for (let i = 0; i < chain.length; i++) if (!expanded.has(chain[i].id) || i === chain.length - 1) return chain[i];
    return chain[chain.length - 1];
}

export function visibleNodes(model: Model, expanded: Set<ElementId>): ViewNode[] {
    const out: ViewNode[] = [];
    const walk = (n: ViewNode) => {
        out.push(n!); // merge rejects an unknown parent, so a parent id is a node of the model
        if (expanded.has(n.id)) n.children.forEach(walk);
    };
    model.roots.forEach(walk);
    return out;
}

/** Raw relations folded to visible nodes: one edge per (from, to, kind group), with the raw ones inside. */
export function foldEdges(model: Model, expanded: Set<ElementId>, filters: Record<string, boolean>): FoldedEdge[] {
    const map = new Map<string, FoldedEdge>();
    for (const e of model.edges) {
        if (!filters[e.group]) continue;
        if (e.style && filters[`style:${e.style}`] === false) continue; // a declared edge style the legend turned off (1.4)
        const a = visibleAncestor(model, expanded, e.from);
        const b = visibleAncestor(model, expanded, e.to);
        if (!a || !b || a === b) continue;
        // a relation inside a collapsed node's own subtree is not drawn
        if (ancestors(model, b.id).includes(a) || ancestors(model, a.id).includes(b)) continue;
        const key = `${a.id}|${b.id}|${e.group}`;
        if (!map.has(key)) map.set(key, { id: key, from: a.id, to: b.id, group: e.group, raw: [] });
        map.get(key)!.raw.push(e);
    }
    return [...map.values()];
}

/** A line's dash and whether it is planned: what all the relations folded into it share (mixed: solid, not planned). */
export function lineStyle(e: Pick<FoldedEdge, 'raw'>): { dash: string; planned: boolean } {
    const dashes = new Set(e.raw.map((r) => r.dash ?? 'solid'));
    return { dash: dashes.size === 1 ? [...dashes][0] : 'solid', planned: e.raw.length > 0 && e.raw.every((r) => r.planned) };
}

/**
 * Routes folded relations along their `via` (spec 1.2: how a relation travels — gateway, API server): a relation is
 * drawn as hops through the visible blocks of its route, and hops shared by many relations become one line with
 * their count (Edge Functions → gateway → Data API → tables is three bundles, not a line per table). A hop before the
 * last is HTTP (`rest`); the last keeps the relation's group. A route block that folds into either end is skipped.
 * Each line keeps `members`: the folded relations (ids) it carries; a relation without a route is its own line.
 */
export function routeVia(model: Model, expanded: Set<ElementId>, folded: FoldedEdge[]): RoutedEdge[] {
    const out = new Map<string, RoutedEdge>();
    const put = (from: ElementId, to: ElementId, group: string, f: { id: string; raw: ViewEdge[] }, transit = false) => {
        const key = `${from}|${to}|${group}`;
        if (!out.has(key)) out.set(key, { id: key, from, to, group, raw: [], members: [], transit: true });
        const seg = out.get(key)!;
        seg.transit &&= transit; // a hop is transit only if nothing ends on it
        for (const r of f.raw) if (!seg.raw.includes(r)) seg.raw.push(r);
        if (!seg.members.includes(f.id)) seg.members.push(f.id);
    };
    const within = (id: ElementId, end: ElementId) => id === end || ancestors(model, end).some((a) => a.id === id) || ancestors(model, id).some((a) => a.id === end);
    for (const f of folded) {
        // relations folded into one line may travel differently: route each kind of route on its own
        const byRoute = new Map<string, ViewEdge[]>();
        for (const r of f.raw) {
            const k = (r.via ?? []).join('>');
            if (!byRoute.has(k)) byRoute.set(k, []);
            byRoute.get(k)!.push(r);
        }
        for (const [k, raw] of byRoute) {
            const part = { id: f.id, raw };
            const route = [f.from];
            for (const v of k ? k.split('>') : []) {
                const vis = visibleAncestor(model, expanded, v)?.id;
                if (vis && !within(vis, f.from) && !within(vis, f.to) && !route.includes(vis)) route.push(vis);
            }
            route.push(f.to);
            for (let i = 0; i < route.length - 1; i++) put(route[i], route[i + 1], i === route.length - 2 ? f.group : 'rest', part, i < route.length - 2);
        }
    }
    return [...out.values()];
}

export function search(model: Model, q: string): SearchHit[] {
    const v = q.trim().toLowerCase();
    if (v.length < 2) return [];
    // score: exact 0, a word starts with the query 1, contains it 3; ties go endpoints → components → the rest → tables
    // (an endpoint whose path has a segment `/webhook…` answers «webhook» before the table webhook_config)
    const words = (t: string) => t.split(/[^a-z0-9]+/).filter(Boolean);
    const scoreOf = (text: string) => (text === v ? 0 : text.startsWith(v) || words(text).some((w) => w.startsWith(v)) ? 1 : text.includes(v) ? 3 : null);
    const KIND: Record<string, number> = { endpoint: 0, component: 1, module: 2, app: 3, table: 5 };
    const hits: SearchHit[] = [];
    for (const n of model.nodes.values()) {
        // every matching endpoint is its own result: picking one opens its path
        for (const ep of n.endpoints ?? []) {
            const sc = scoreOf(ep.path.toLowerCase()) ?? scoreOf(`${ep.method} ${ep.path}`.toLowerCase());
            if (sc !== null) hits.push({ node: n, endpoint: ep, score: sc, kind: KIND.endpoint });
        }
        const t = n.title.toLowerCase();
        const sc = scoreOf(t) ?? (n.file?.toLowerCase().includes(v) ? 3 : null);
        if (sc !== null) hits.push({ node: n, score: sc, kind: KIND[n.type] ?? 4 });
    }
    return hits.sort((a, b) => a.score - b.score || a.kind - b.kind || (a.endpoint?.path.length ?? a.node.title.length) - (b.endpoint?.path.length ?? b.node.title.length)).slice(0, 14);
}

/** The node itself or one of its descendants. */
export const inside = (model: Model, id: ElementId, rootId: ElementId): boolean => id === rootId || ancestors(model, id).some((a) => a.id === rootId);

/** Depth of every node (root = 0), set once. Client-layer systems do not count: their apps are the top level. */
export function setDepths(model: Model): void {
    for (const n of model.nodes.values()) n.depth = ancestors(model, n.id).filter((a) => a.type !== 'system').length;
}

// ---------- core questions (core/queries.js, core/path.js) on view ids ----------

/**
 * What a node and everything inside it talks to, at full resolution (core edges, not what the map shows).
 * Owners are view nodes (an endpoint is its component); a synthetic group answers for its members.
 */
export function summary(model: Model, rootId: ElementId) {
    const within = model.merged.byId.has(rootId) ? undefined : (id: ElementId) => inside(model, model.nodeOf(id), rootId);
    const s = coreSummary(model.merged, rootId, { within });
    const view = (list: SummaryEntry[]) =>
        list.map((g) => ({ ...g, owner: model.nodes.get(model.nodeOf(g.owner.id)) ?? { id: g.owner.id, title: g.owner.name } }));
    return { in: view(s.in), tables: view(s.tables), out: view(s.out) };
}

/** Path steps with view ids: `kind` = core channel; a break step stays on its node. */
const viewSteps = (model: Model, steps: PathStep[]): ViewStep[] =>
    steps.map((s) => ({ ...s, from: model.nodeOf(s.from), to: s.to ? model.nodeOf(s.to) : model.nodeOf(s.from), kind: s.channel }));

/** Path of `id#method` (core/path.js). */
export const trace = (model: Model, id: ElementId, method: MethodName): ViewStep[] => viewSteps(model, coreTrace(model.merged, id, method));

/** All methods of a component traced together. */
export const traceNode = (model: Model, id: ElementId): ViewStep[] => viewSteps(model, coreTraceNode(model.merged, id));
