// A deterministic journey over authored steps. Only explicit, unambiguous continuations are followed.
import type { CinemaLeg, CinemaPlan, Model, ScenarioStep, ViewEdge } from '../../types/viewer.ts';

const SYNC = new Set(['call', 'rest', 'https', 'read', 'write']);
const start = (s: ScenarioStep) => s.kind === 'element' ? s.element : s.edges.find((e) => !s.edges.some((other) => other.to === e.from))?.from ?? s.from;
const end = (s: ScenarioStep) => s.kind === 'element' ? s.element : s.to;

/** Bounded unique continuation: never choose an alternate branch to make a scenario connect. */
function continuation(outgoing: Map<string, ViewEdge[]>, from: string, to: string): ViewEdge[] | 'ambiguous' | null {
    if (from === to) return [];
    const queue = [{ at: from, path: [] as ViewEdge[], seen: new Set([from]) }];
    const found: ViewEdge[][] = [];
    let truncated = false;
    for (let visits = 0; queue.length && visits < 256; visits++) {
        const item = queue.shift()!;
        if (item.path.length >= 5) {
            if ((outgoing.get(item.at) ?? []).some((edge) => !item.seen.has(edge.to))) truncated = true;
            continue;
        }
        for (const edge of outgoing.get(item.at) ?? []) {
            if (item.seen.has(edge.to)) continue;
            const path = [...item.path, edge];
            if (edge.to === to) found.push(path);
            else queue.push({ at: edge.to, path, seen: new Set([...item.seen, edge.to]) });
            if (found.length > 1) return 'ambiguous';
        }
    }
    return queue.length || truncated ? 'ambiguous' : found[0] ?? null;
}

function independentAction(model: Model, from: string, to: string): boolean {
    const participant = (id: string): string | null => {
        let node = model.nodes.get(id);
        for (let guard = 0; node && guard < 64; guard++) {
            if (node.type === 'actor' || node.type === 'app') return node.id;
            node = node.parent ? model.nodes.get(node.parent) : undefined;
        }
        return null;
    };
    const target = participant(to);
    return target !== null && target !== participant(from);
}

/** Sibling processing in the callee's module does not complete an outstanding outer request. */
function sameExecutionContext(model: Model, callee: string, target: string): boolean {
    const scope = (id: string): string | null => {
        let node = model.nodes.get(id);
        for (let guard = 0; node && guard < 64; guard++) {
            if (node.type === 'module') return node.id;
            if (node.type === 'app' || node.type === 'system') return null;
            node = node.parent ? model.nodes.get(node.parent) : undefined;
        }
        return null;
    };
    const context = scope(callee);
    if (!context) return false;
    let node = model.nodes.get(target);
    for (let guard = 0; node && guard < 64; guard++) {
        if (node.id === context) return true;
        node = node.parent ? model.nodes.get(node.parent) : undefined;
    }
    return false;
}

interface Pending { edge: ViewEdge; step: number }
interface Publication { edge: ViewEdge; step: number }
type Continuation = ReturnType<typeof continuation>;
interface Connection {
    model: Model;
    outgoing: Map<string, ViewEdge[]>;
    pending: Pending[];
    publications: Publication[];
    readonly current: string;
    add(kind: CinemaLeg['kind'], step: number, from: string, to: string, edge?: ViewEdge): void;
    send(edge: ViewEdge, step: number): void;
    unwind(step: number): void;
}

function isInternal(model: Model, call: Pending, target: string, path: Continuation): boolean {
    return target !== call.edge.from && (sameExecutionContext(model, call.edge.to, target) || path !== null);
}

/** Keep authored order; pending synchronous calls return before their caller continues. */
export function planCinema(model: Model, steps: ScenarioStep[]): CinemaPlan {
    const legs: CinemaLeg[] = [], pending: Pending[] = [], publications: Publication[] = [];
    const outgoing = new Map<string, ViewEdge[]>();
    for (const edge of model.edges) if (['call', 'import', 'read', 'write', 'rest', 'https', 'smtp', 'trigger'].includes(edge.kind)) {
        outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    }
    let current: string | null = null;
    const add = (kind: CinemaLeg['kind'], step: number, from: string, to: string, edge?: ViewEdge) => {
        legs.push({ kind, step, from, to, edge, contract: edge?.contract ?? null });
        current = to;
    };
    const send = (edge: ViewEdge, step: number, authored = false) => {
        const top = pending.at(-1);
        if (authored && SYNC.has(edge.kind) && top && edge.from === top.edge.to && edge.to === top.edge.from) {
            pending.pop();
            add('response', step, edge.from, edge.to, top.edge);
        } else {
            add(edge.kind === 'event' ? 'delivery' : 'request', step, edge.from, edge.to, edge);
            if (SYNC.has(edge.kind)) pending.push({ edge, step });
            if (edge.kind === 'event') publications.push({ edge, step });
        }
    };
    const unwind = (step: number) => {
        const call = pending.pop()!;
        if (current !== call.edge.to) add('unspecified', step, current!, call.edge.to);
        add('response', step, call.edge.to, call.edge.from, call.edge);
    };
    steps.forEach((step, i) => {
        const target = start(step);
        if (current && current !== target) connectCinema({ model, outgoing, pending, publications, get current() { return current!; }, add, send, unwind }, target, i, step.kind === 'element');
        if (step.kind === 'element') add('processing', i, step.element, step.element);
        else playAuthored(step, i);
    });
    while (pending.length) unwind(Math.max(0, steps.length - 1));
    return { legs };

    function playAuthored(step: Extract<ScenarioStep, { kind: 'edge' }>, i: number): void {
        const route = authoredRoute(step);
        if (!route.length) {
            const top = pending.at(-1);
            if (step.channel && SYNC.has(step.channel) && top && step.from === top.edge.to && step.to === top.edge.from) {
                pending.pop();
                add('response', i, step.from, step.to, top.edge);
            } else add('unspecified', i, step.from, end(step));
            return;
        }
        route.forEach((e) => send(e, i, true));
        const last = legs.at(-1)!;
        if (step.contract) {
            last.contract = step.contract;
            const call = pending.at(-1);
            if (call && call.edge === last.edge) call.edge = { ...call.edge, contract: step.contract };
        }
    }
}

function connectCinema(connection: Connection, target: string, i: number, action: boolean): void {
    const { model, outgoing, pending, publications, add, send, unwind } = connection;
    if (startsIndependent(connection, target, action)) {
        while (pending.length) unwind(i);
        if (connection.current !== target) add('independent', i, connection.current, target);
        return;
    }
    // Returning to a known caller completes the outstanding call, even if a new call graph edge points back.
    returnToCaller(connection, target, i);
    let path = continuation(outgoing, connection.current, target);
    while (path === null && pending.length) {
        const call = pending.at(-1)!;
        const internal = continuation(outgoing, call.edge.to, target);
        if (isInternal(model, call, target, internal)) {
            if (Array.isArray(internal)) {
                if (connection.current !== call.edge.to) add('unspecified', i, connection.current, call.edge.to);
                internal.forEach((edge) => send(edge, i));
            } else add('unspecified', i, connection.current, target);
            return;
        }
        unwind(i);
        path = continuation(outgoing, connection.current, target);
    }
    if (path === 'ambiguous') { add('unspecified', i, connection.current, target); return; }
    if (path) { path.forEach((e) => send(e, i)); return; }
    const event = eventRoute(model, publications, target, outgoing);
    if (event) {
        if (connection.current !== event.publication.edge.to) add('attention', i, connection.current, event.publication.edge.to);
        event.path.forEach((e) => send(e, i));
        return;
    }
    const independent = independentAction(model, connection.current, target);
    add(independent ? 'independent' : 'unspecified', i, connection.current, target);
}

function returnToCaller(connection: Connection, target: string, i: number): void {
    if (!connection.pending.some((call) => call.edge.from === target)) return;
    while (connection.pending.length && connection.current !== target) connection.unwind(i);
}

function startsIndependent(connection: Connection, target: string, action: boolean): boolean {
    if (connection.model.nodes.get(target)?.type === 'actor') return true;
    const layer = connection.model.nodes.get(target)?.layer;
    if (!action || (layer !== 'ui' && layer !== 'people')) return false;
    if (connection.pending.some((call) => call.edge.from === target)) return false;
    if (connection.pending.some((call) => sameExecutionContext(connection.model, call.edge.to, target))) return false;
    return independentAction(connection.model, connection.current, target);
}

function eventRoute(model: Model, publications: Publication[], target: string, outgoing: Map<string, ViewEdge[]>): { publication: Publication; path: ViewEdge[] } | null {
    const candidates: { publication: Publication; path: ViewEdge[] }[] = [];
    for (const publication of publications) {
        const pub = publication.edge;
        if (!pub.toMethod) continue;
        for (const edge of model.edges) {
            if (edge.kind !== 'event' || edge.from !== pub.to || edge.fromMethod !== pub.toMethod) continue;
            const tail = continuation(outgoing, edge.to, target);
            if (tail === 'ambiguous') return null;
            if (tail) candidates.push({ publication, path: [edge, ...tail] });
            if (candidates.length > 1) return null;
        }
    }
    return candidates[0] ?? null;
}

function authoredRoute(step: Extract<ScenarioStep, { kind: 'edge' }>): ViewEdge[] {
    const route: ViewEdge[] = [];
    let at = start(step);
    const destination = step.edges.length === 1 ? step.edges[0].to : step.to;
    for (let guard = 0; guard < 8 && at !== destination; guard++) {
        const choices = step.edges.filter((e) => e.from === at);
        if (choices.length !== 1) break;
        const edge = choices[0];
        const previous = route.at(-1);
        if (previous?.kind === 'event' && edge.kind === 'event' && (!previous.toMethod || previous.toMethod !== edge.fromMethod)) break;
        route.push(edge);
        at = edge.to;
    }
    return at === destination ? route : [];
}

/** The active publication and its authored branches; other topics and future publications stay quiet. */
export function cinemaEventFork(model: Model, plan: CinemaPlan, active: CinemaLeg): CinemaLeg[] {
    const legs = plan.legs;
    let index = legs.indexOf(active);
    if (index < 0) index = legs.findIndex((leg) => leg.kind === 'delivery' && leg.step === active.step && leg.to === active.to);
    if (index < 0) return [];
    const before: CinemaLeg[] = [];
    for (let i = index; i >= 0 && legs[i].kind !== 'independent'; i--) before.push(legs[i]);
    const delivery = before.find((leg) => leg.kind === 'delivery' && leg.edge);
    if (!delivery?.edge) return [];
    const publication = publicationOf(model, before, delivery);
    if (!publication) return [];
    const edge = publication.edge!;
    if (!edge.toMethod) return [];
    const after = legs.slice(legs.indexOf(publication) + 1);
    const next = after.findIndex((leg) => leg.kind === 'delivery' && leg.edge?.to === edge.to && leg.edge.toMethod === edge.toMethod);
    const branches = (next < 0 ? after : after.slice(0, next)).filter((leg) => leg.kind === 'delivery' && leg.edge?.from === edge.to && leg.edge.fromMethod === edge.toMethod);
    return [publication, ...branches];
}

function publicationOf(model: Model, before: CinemaLeg[], delivery: CinemaLeg): CinemaLeg | undefined {
    const rail = (leg: CinemaLeg) => ['bus', 'queue', 'job'].includes(model.nodes.get(leg.edge!.to)?.type ?? '');
    if (rail(delivery)) return delivery;
    return before.find((leg) => leg.kind === 'delivery' && leg.edge && rail(leg) && leg.edge.to === delivery.edge!.from && leg.edge.toMethod === delivery.edge!.fromMethod);
}
