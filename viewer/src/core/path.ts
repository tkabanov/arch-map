// Path (docs/architecture.md AD-4): what happens when a method runs, as numbered steps — a pure walk
// over core edges of merged specs.
// Pure ESM: no DOM, no three.js, no Node built-ins. Reads no facets.
//
// Walk rules:
// - edges leaving `<component>#<method>` (by `fromMethod`) are the steps of that method;
// - a call to its own method (from === to) is not a step: the walk continues on the same level;
// - `call`/`event`/`trigger` with `toMethod` recurse into `to#toMethod`;
// - `rest`/`webhook` to an endpoint recurse into its component's `handler` (a function calling another
//   app's route, e.g. an Edge Function calling a Postgres RPC);
// - `schedule` recurses the same way: into `to#toMethod`, or, to an endpoint, into its handler (a pg_cron
//   job calling an Edge Function or a SQL function) —
//   the scheduled work runs later, but it is what the method sets going, so it is the next level;
// - `read`/`write`/`https`/`smtp` are leaves, except that a `write` to a table is followed by the `trigger`
//   edges leaving that table (a database trigger fires on the write);
// - a method is walked once per Path: a step into a method that is already walked is a leaf; into one that is
//   still being walked (an ancestor: recursion, e.g. a workflow that schedules itself) it also has `cycle: true`;
// - each `unresolved[]` entry of a method is an explicit break step (`channel: 'break'`).
import type { MergedCore, PathIndex, PathOptions, PathStep } from '../../../types/core.ts';
import type { Channel, Edge, ElementId, Method, MethodName } from '../../../types/spec.d.ts';

const ORDER: Channel[] = ['call', 'read', 'write', 'event', 'rest', 'webhook', 'https', 'smtp', 'trigger', 'schedule'];
const rank = (c: Channel): number => {
    const i = ORDER.indexOf(c);
    return i < 0 ? ORDER.length : i;
};
// channels whose step enters the next level: into `to#toMethod`, or into an endpoint's handler
const INTO_METHOD = new Set<Channel>(['call', 'event', 'trigger', 'schedule']);
const INTO_HANDLER = new Set<Channel>(['rest', 'webhook', 'schedule']);
const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

const indexes = new WeakMap<MergedCore, PathIndex>();

/** Per merged set: edges by `from#fromMethod`, trigger edges by table, methods by component. */
export function pathIndex(merged: MergedCore): PathIndex {
    let idx = indexes.get(merged);
    if (idx) return idx;
    const out = new Map<string, Edge[]>();
    const triggers = new Map<ElementId, Edge[]>();
    for (const e of merged.edges) {
        if (e.fromMethod) {
            const k = `${e.from}#${e.fromMethod}`;
            (out.get(k) ?? out.set(k, []).get(k)!).push(e);
        } else if (e.channel === 'trigger') {
            (triggers.get(e.from) ?? triggers.set(e.from, []).get(e.from)!).push(e);
        }
    }
    const sort = (list: Edge[]) => list.sort((a, b) => rank(a.channel) - rank(b.channel) || cmp(a.id, b.id));
    for (const list of out.values()) sort(list);
    for (const list of triggers.values()) sort(list);
    const methods = new Map<ElementId, Map<MethodName, Method>>();
    for (const el of merged.elements) if (el.methods) methods.set(el.id, new Map(el.methods.map((m) => [m.name, m])));
    idx = { out, triggers, methods };
    indexes.set(merged, idx);
    return idx;
}

const labelOf = (e: Edge): string => {
    if (e.channel === 'call') return `${e.toMethod ?? ''}()`;
    if (e.ops?.length) return e.ops.join(', ');
    return e.label ?? e.toMethod ?? '';
};

/**
 * Steps of running `startId#startMethod`, depth first. Step: { from, fromMethod?, to, toMethod?, channel,
 * label, edge (edge id), depth, parent (index of the step it came from, -1 at the top), cycle? }; a break step has
 * `channel: 'break'`, `expr`, `line`, `label: 'break: <expr>'` and no `to`.
 */
// Cap long traversals at 500 steps; the panel folds their deeper levels
export const MAX_STEPS = 500;
export function trace(merged: MergedCore, startId: ElementId, startMethod: MethodName, { maxSteps = MAX_STEPS, maxDepth = 9 }: PathOptions = {}): PathStep[] {
    const { out, triggers, methods } = pathIndex(merged);
    const steps: PathStep[] = [];
    const seen = new Set<string>();
    const open = new Set<string>(); // methods being walked: the current chain from the start
    const push = (s: PathStep): number => steps.push(s) - 1;
    // the method an edge leads into (its next level): `toMethod`, or an endpoint's handler; null for a leaf
    const nextLevel = (e: Edge): [ElementId, MethodName] | null => {
        if (e.toMethod && INTO_METHOD.has(e.channel)) return [e.to, e.toMethod];
        if (!INTO_HANDLER.has(e.channel)) return null;
        const ep = merged.byId.get(e.to);
        return ep?.type === 'endpoint' && ep.handler && ep.parent ? [ep.parent, ep.handler] : null;
    };
    const follow = (e: Edge, depth: number, parent: number): void => {
        if (steps.length >= maxSteps) return;
        const s = step(e, depth, parent);
        const next = nextLevel(e);
        if (next && open.has(`${next[0]}#${next[1]}`)) s.cycle = true; // recursion: that method is still being walked
        const at = push(s);
        if (next) walk(next[0], next[1], depth, at);
        else if (e.channel === 'write') for (const t of triggers.get(e.to) ?? []) follow(t, depth + 1, at); // a trigger fires on the write
    };
    const walk = (id: ElementId, method: MethodName, depth: number, parent: number): void => {
        const key = `${id}#${method}`;
        if (seen.has(key) || depth > maxDepth || steps.length >= maxSteps) return;
        seen.add(key);
        open.add(key);
        for (const e of out.get(key) ?? []) {
            if (steps.length >= maxSteps) return;
            if (e.from === e.to && e.channel === 'call') {
                if (e.toMethod) walk(id, e.toMethod, depth, parent); // own method: stays on this level
                continue;
            }
            follow(e, depth + 1, parent);
        }
        for (const u of methods.get(id)?.get(method)?.unresolved ?? []) {
            if (steps.length >= maxSteps) return;
            push({ from: id, fromMethod: method, channel: 'break', expr: u.expr, line: u.line, label: `break: ${u.expr}`, depth: depth + 1, parent });
        }
        open.delete(key);
    };
    walk(startId, startMethod, 0, -1);
    return steps;
}

const step = (e: Edge, depth: number, parent: number): PathStep => ({
    from: e.from,
    ...(e.fromMethod ? { fromMethod: e.fromMethod } : {}),
    to: e.to,
    ...(e.toMethod ? { toMethod: e.toMethod } : {}),
    channel: e.channel,
    label: labelOf(e),
    edge: e.id,
    depth,
    parent,
});

/** Path of an endpoint: its component's handler method. Empty when the endpoint has no handler. */
export function traceEndpoint(merged: MergedCore, endpointId: ElementId, options?: PathOptions): PathStep[] {
    const ep = merged.byId.get(endpointId);
    if (ep?.type !== 'endpoint' || !ep.handler || !ep.parent) return [];
    return trace(merged, ep.parent, ep.handler, options);
}

/** All methods of a component traced together (its whole reach), without repeating steps. */
export function traceNode(merged: MergedCore, id: ElementId, { maxSteps = 300 }: { maxSteps?: number } = {}): PathStep[] {
    const ms = pathIndex(merged).methods.get(id);
    if (!ms) return [];
    const all: PathStep[] = [];
    const seen = new Set<string>();
    const key = (s: PathStep) => `${s.from}|${s.to}|${s.channel}|${s.label}`;
    for (const m of ms.keys()) {
        for (const s of trace(merged, id, m, { maxSteps: 120 })) {
            if (seen.has(key(s))) continue;
            seen.add(key(s));
            all.push({ ...s, parent: -1 });
        }
    }
    return all.slice(0, maxSteps);
}
