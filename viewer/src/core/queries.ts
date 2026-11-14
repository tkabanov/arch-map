// Questions over merged specs: who calls X, who reads / writes table Y, what a part of
// the system talks to.
// Pure ESM: no DOM, no three.js, no Node built-ins. Reads no facets.
import type { MergedCore, Summary, SummaryEntry } from '../../../types/core.ts';
import type { Channel, Element, ElementId } from '../../../types/spec.d.ts';
import { isWithin } from './resolve.ts';
import { tierOf } from './tier.ts';

const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

/** Ids of the elements that write table `tableId` (`write` edges), sorted. */
export const writers = (merged: MergedCore, tableId: ElementId): ElementId[] => uniqSorted(merged.edges.filter((e) => e.channel === 'write' && e.to === tableId).map((e) => e.from));

/** Ids of the elements that read table `tableId` (`read` edges), sorted. */
export const readers = (merged: MergedCore, tableId: ElementId): ElementId[] => uniqSorted(merged.edges.filter((e) => e.channel === 'read' && e.to === tableId).map((e) => e.from));

/** Channels that mean "is invoked by" (imports, FKs, data access and client-layer `interacts` are not). */
export const CALL_CHANNELS = new Set<Channel>(['call', 'rest', 'event', 'webhook', 'trigger', 'schedule']);

/**
 * Ids of the elements outside `id` that invoke `id` or anything inside it (an endpoint, a method),
 * sorted. With `{ methods: true }`, `from#fromMethod` where the caller method is known.
 */
export function callers(merged: MergedCore, id: ElementId, { methods = false }: { methods?: boolean } = {}): string[] {
    const out: string[] = [];
    for (const e of merged.edges) {
        if (!CALL_CHANNELS.has(e.channel) || !isWithin(merged, e.to, id) || isWithin(merged, e.from, id)) continue;
        out.push(methods && e.fromMethod ? `${e.from}#${e.fromMethod}` : e.from);
    }
    return uniqSorted(out);
}

/** Root-to-element chain of ids, without client-layer systems (their children are the apps). */
function chainOf(merged: MergedCore, id: ElementId): Element[] {
    const chain: Element[] = [];
    let cur: Element | null | undefined = merged.byId.get(id);
    for (let guard = 0; cur && guard < 64; guard++) {
        if (cur.type !== 'system') chain.unshift(cur);
        cur = cur.parent ? merged.byId.get(cur.parent) : null;
    }
    return chain;
}

/**
 * The element that names where `id` lives: on the data tier the element itself; otherwise the child of its
 * app (a front area, a backend folder, an Edge Function), or the element itself when it is that shallow
 * (an app, a client-layer system or actor).
 */
export function ownerOf(merged: MergedCore, id: ElementId): Element | null {
    const el = merged.byId.get(id);
    if (!el) return null;
    if (tierOf(merged, id) === 'data') return el;
    const chain = chainOf(merged, id);
    return chain[Math.min(1, chain.length - 1)] ?? el;
}

/**
 * What an element and everything inside it talks to, at full resolution (core edges, not the folded map).
 * Returns { in, tables, out }: lists of { owner (element), channel, n, extra: [] } sorted by n desc.
 * `in`: who invokes it, grouped by owner and channel; `tables`: tables it reads/writes (`channel: 'data'`,
 * `extra` ⊆ ['r', 'w']); `out`: other parts, events, outside systems. Imports and FKs are skipped.
 * `within(id)` replaces "is `id` inside `rootId`" for a root that is not an element (the viewer's synthetic groups).
 */
type Bucket = 'in' | 'tables' | 'out';
type Group = Omit<SummaryEntry, 'extra'> & { bucket: Bucket; extra: Set<string> };

export function summary(merged: MergedCore, rootId: ElementId, { within }: { within?: (id: ElementId) => boolean } = {}): Summary {
    const inside = within ?? ((id: ElementId) => isWithin(merged, id, rootId));
    const groups = new Map<string, Group>();
    const add = (bucket: Bucket, owner: Element, channel: SummaryEntry['channel'], extra?: string) => {
        const key = `${bucket}|${owner.id}|${channel}`;
        if (!groups.has(key)) groups.set(key, { bucket, owner, channel, n: 0, extra: new Set() });
        const g = groups.get(key)!;
        g.n += 1;
        if (extra) g.extra.add(extra);
    };
    for (const e of merged.edges) {
        if (e.channel === 'import' || e.channel === 'references') continue;
        const a = inside(e.from);
        const b = inside(e.to);
        if (a === b) continue;
        // merged edges start and end at loaded elements (merge drops the rest), so ownerOf finds an owner
        if (b) add('in', ownerOf(merged, e.from)!, e.channel);
        else {
            const to = merged.byId.get(e.to);
            if (to?.type === 'table' && (e.channel === 'read' || e.channel === 'write')) add('tables', to, 'data', e.channel === 'write' ? 'w' : 'r');
            else add('out', ownerOf(merged, e.to)!, e.channel);
        }
    }
    const list = (bucket: Bucket): SummaryEntry[] =>
        [...groups.values()]
            .filter((g) => g.bucket === bucket)
            .map(({ bucket: _b, ...g }) => ({ ...g, extra: [...g.extra].sort() }))
            .sort((x, y) => y.n - x.n || (x.owner.id < y.owner.id ? -1 : 1));
    return { in: list('in'), tables: list('tables'), out: list('out') };
}
