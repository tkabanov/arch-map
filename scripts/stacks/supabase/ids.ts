// Spec-building parts shared by the documents of a Supabase project's code (Edge Functions, a React client app): how a
// supabase-js call travels (`via`), the ids of the Supabase document that clients point at, and a matcher from an HTTP
// path to a route. Pure.
import type { Element } from '../../../types/spec.d.ts';
import type { RouteItem, SupabaseConfig, SupabaseIds, SupabaseVia } from '../../../types/stacks/supabase.ts';

/** How supabase-js calls travel: the gateway, then PostgREST (`.from`/`.rpc`) or Storage; `/functions/v1` and `/auth/v1` pass the gateway. */
export function supabaseVia(ids: Pick<SupabaseIds, 'gateway' | 'rest' | 'storage'>): SupabaseVia {
    const GW = ids.gateway;
    return {
        REST: GW && ids.rest ? [GW, ids.rest] : undefined,
        STORAGE: GW && ids.storage ? [GW, ids.storage] : undefined,
        GW: GW ? [GW] : undefined,
    };
}

/**
 * The ids a client points at, from the elements of the Supabase document: tables / views by `schema.name`, RPC
 * endpoints by `public.fn`, buckets, the platform apps (their ids from the config's `SUPABASE_SERVICES`; null when the
 * document has no such element).
 */
export function supabaseIds(els: Element[], config: Pick<SupabaseConfig, 'SUPABASE_SERVICES'>): SupabaseIds {
    const has = (key: string): string | null => {
        const id = config.SUPABASE_SERVICES[key]?.id;
        return id && els.some((e) => e.id === id) ? id : null;
    };
    return {
        tables: new Map(els.filter((e) => e.type === 'table' && e.facets?.['pg.table'] || e.facets?.['pg.view']).map((e) => [`${((e.facets!['pg.table'] ?? e.facets!['pg.view']) as { schema: string }).schema}.${e.name}`, e.id])),
        rpcs: new Map(els.filter((e) => e.type === 'endpoint' && e.http?.path.startsWith('/rest/v1/rpc/')).map((e) => [`public.${e.http!.path.split('/').pop()}`, e.id])),
        buckets: new Map(els.filter((e) => e.facets?.['storage.bucket']).map((e) => [e.name, e.id])),
        gateway: has('gateway'),
        rest: has('rest'),
        storage: has('storage'),
        auth: has('auth'),
    };
}

/**
 * A matcher from (path, method) to one route: `items` = [{ full, method, value }], `full` with `:param` or `{param}`
 * segments. `${*}` in the asked path matches one segment. Returns the one value, or null when none or several match
 * (without a method: the one route of any method, else null). `preferLiteral`: when several match, the one with the
 * fewest parameter segments wins if it is the only one with that count (a router tries `/check` before `/{id}`).
 */
export function routeMatcher<V>(items: RouteItem<V>[], { preferLiteral = false }: { preferLiteral?: boolean } = {}): (path: string, method?: string) => V | null {
    const rx = items.map((x) => ({ ...x, params: (x.full.match(/:\w+|\{\w+\}/g) ?? []).length, rx: new RegExp(`^${x.full.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/:\w+|\{\w+\}/g, '[^/]+')}$`) }));
    const literal = (list: typeof rx): typeof rx => {
        if (!preferLiteral || list.length < 2) return list;
        const min = Math.min(...list.map((x) => x.params));
        const best = list.filter((x) => x.params === min);
        return best.length === 1 ? best : list;
    };
    return (path, method) => {
        const p = path.replace(/[?#].*$/, '').replace(/\/$/, '') || '/';
        // a dynamic segment of the caller (`${*}`) is a value, never the literal of a route
        const hit = (x: (typeof rx)[number]) => x.rx.test(p) || x.rx.test(p.replace(/\$\{\*\}/g, 'x'));
        const concrete = literal(rx.filter((x) => hit(x) && (!method || x.method === method)));
        if (concrete.length === 1) return concrete[0].value;
        const anyMethod = rx.filter(hit);
        return !method && anyMethod.length === 1 ? anyMethod[0].value : null;
    };
}
