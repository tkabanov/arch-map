// Tiers (docs/architecture.md AD-11): which horizontal layers the map has, and the tier of an element — the one place
// both are computed. The list comes from the specs (a document may declare `tiers`, core/merge.ts keeps one list for
// the merged set); without a declaration it is DEFAULT_TIERS.
// Pure ESM: no DOM, no three.js, no Node built-ins.
import type { MergedCore, MergedSet } from '../../../types/core.ts';
import type { ElementId, ElementType, Tier, TierId } from '../../../types/spec.d.ts';

/** Layers top-down, with their titles, when no document declares its own. */
export const DEFAULT_TIERS: Tier[] = [
    { id: 'people', title: 'People' },
    { id: 'ui', title: 'Interfaces' },
    { id: 'service', title: 'Services' },
    { id: 'data', title: 'Data & external systems' },
];

/**
 * Cross-cutting element types: an event bus, a queue, a scheduler's jobs. They are not a layer and never a column:
 * the map draws each as a rail across its column, just below its tier.
 */
export const RAIL_TYPES = new Set<string>(['bus', 'queue', 'job']);
/** Takes a spec element or a viewer node (anything with a `type`). */
export const isRail = (el: { type: string } | null | undefined): boolean => el != null && RAIL_TYPES.has(el.type);

/** The tier list of a merged set (`merged.tiers`, set by core/merge.ts), else the default. */
export const tiersOf = (merged: Partial<Pick<MergedSet, 'tiers'>> | null | undefined): Tier[] => (merged?.tiers?.length ? merged.tiers : DEFAULT_TIERS);

const BY_TYPE: Partial<Record<ElementType, TierId>> = {
    actor: 'people',
    datastore: 'data',
    table: 'data',
    'external-system': 'data',
    job: 'service',
    queue: 'service',
    bus: 'service',
};

interface TierCache {
    children: Map<ElementId, ElementId[]>;
    tier: Map<ElementId, TierId | null>;
    rank: Map<TierId, number>;
    fallback: TierId;
}

const caches = new WeakMap<MergedCore, TierCache>();

/**
 * Tier of element `id` in a merged set: own `tier`, else the parent's, else by type; a `system` takes the
 * topmost tier among its descendants. Elements nothing decides (a lone module, an empty system) are `service`.
 * A tier the merged set does not have (a document that declares tiers without `data`) falls back the same way.
 */
export function tierOf(merged: MergedCore, id: ElementId): TierId {
    let cache = caches.get(merged);
    if (!cache) {
        const children = new Map<ElementId, ElementId[]>();
        for (const el of merged.elements) if (el.parent) (children.get(el.parent) ?? children.set(el.parent, []).get(el.parent)!).push(el.id);
        const tiers = tiersOf(merged);
        const rank = new Map(tiers.map((t, i) => [t.id, i]));
        // the fallback: «service» when the set has it, else the middle of the list
        const fallback = rank.has('service') ? 'service' : tiers[Math.floor((tiers.length - 1) / 2)].id;
        cache = { children, tier: new Map(), rank, fallback };
        caches.set(merged, cache);
    }
    return compute(merged, cache, id, 0) ?? cache.fallback;
}

function compute(merged: MergedCore, cache: TierCache, id: ElementId, depth: number): TierId | null {
    if (cache.tier.has(id)) return cache.tier.get(id) ?? null;
    const el = merged.byId.get(id);
    const known = (t: string | null | undefined): TierId | null => (t && cache.rank.has(t) ? t : null);
    let tier: TierId | null = null;
    if (el && depth < 64) {
        if (known(el.tier)) tier = el.tier as TierId; // known() is true only for a defined tier
        else if (el.type === 'system') {
            const below = (cache.children.get(id) ?? []).map((c) => compute(merged, cache, c, depth + 1) ?? cache.fallback);
            // every tier in `below` is ranked (compute returns ranked tiers only, the fallback is ranked)
            tier = below.length ? below.reduce((a, b) => (cache.rank.get(b)! < cache.rank.get(a)! ? b : a)) : null;
        } else {
            const parent = el.parent ? merged.byId.get(el.parent) : null;
            if (parent && parent.type !== 'system') tier = compute(merged, cache, parent.id, depth + 1);
            tier ??= known(BY_TYPE[el.type]);
        }
    }
    cache.tier.set(id, tier);
    return tier;
}
