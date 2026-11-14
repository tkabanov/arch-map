// The shared state of `buildEdgeSpec` (edge-spec.ts) and the helpers its passes use: the inputs, the elements and
// edges being accumulated, what a URL in the code is, which folder of supabase/functions is what. Each pass
// (edge-elements.ts, edge-edges.ts) takes this context.
import { seg, specBuilder } from '../../lib/spec-build.ts';
import { routeMatcher } from './ids.ts';
import type { ConfigSource, Site } from '../../../types/spec.d.ts';
import type { SpecBuilder, UnresolvedEntry } from '../../../types/generator.ts';
import type { DbHttpCall, Domains, EdgeAnalysis, EdgeRoute, EdgeUnit, SupabaseIds, SupabaseConfig } from '../../../types/stacks/supabase.ts';

/** The project's own OpenAPI (supabase/functions/openapi/schema.ts), as far as it is read here (open JSON). */
export type OpenApiBody = { content?: Record<string, { schema?: unknown } | undefined> } | undefined;
export interface EdgeOpenApi {
    openapi?: unknown;
    info?: Record<string, unknown>;
    servers?: unknown;
    paths?: Record<string, Record<string, { requestBody?: OpenApiBody; responses?: Record<string, OpenApiBody> } | undefined> | undefined>;
}
/** The inputs of `buildEdgeSpec`. */
export interface EdgeInput {
    analysis: EdgeAnalysis;
    openapi: EdgeOpenApi | null;
    config: SupabaseConfig;
    ids: SupabaseIds;
    dbHttp: DbHttpCall[];
    commit: string | null;
    fnConfig: (name: string) => Record<string, unknown>;
    tomlAt: (section: string) => Site | undefined;
    domains?: Domains | null;
}
/** What a URL is: `{ route }` of an Edge Function, `{ rest }` (Data API), `{ ext, host }`, or `{ none }`. */
export interface UrlTarget {
    route?: EdgeRoute;
    rest?: boolean;
    ext?: string;
    host?: string;
    none?: string;
    path?: string;
}
/** A module of the document: an Edge Function's folder, a shared folder, or a domain cluster (`domain: true`). */
export interface EdgeModule {
    id: string;
    name: string;
    parent: string;
    folder: string | null;
    domain?: string | true;
}

export const FN_DIR = 'supabase/functions';
/** `basePath + path` of a route (both folded literals: strings in practice). */
export const fullOf = (r: EdgeRoute): string => (r.basePath as string) + ((r.path as string | undefined) ?? '');
export const pascal = (s: unknown): string => String(s).replace(/(^|[_-])(\w)/g, (_: string, __: string, c: string) => c.toUpperCase()).replace(/^(\w)/, (c: string) => c.toUpperCase());
export const top = (file: string): string => file.split('/')[0];

/** What `buildEdgeSpec` accumulates; every pass reads the inputs and adds to it. */
export interface EdgeCtx extends EdgeInput {
    units: EdgeUnit[];
    routes: EdgeRoute[];
    REPO_ID: string;
    /** the Edge Functions app (`<ID>.edge`): the root of every id of the document */
    APP: string;
    b: SpecBuilder;
    unresolved: UnresolvedEntry[];
    routeFns: Set<string>;
    /** function folder → its domain cluster; set once what each function touches is known */
    fnDomain: Map<string, string>;
    portExt: Map<string, string>;
    /** a route by method + URL path (`/fn/…`); `${*}` in the URL matches one segment; null when none or several */
    matchRoute: (path: string, method?: string) => EdgeRoute | null;
    /** the units that serve a route */
    handlers: Set<EdgeUnit>;
    /** the units that reach something, or call one that does */
    relevant: Set<EdgeUnit>;
    /** relevant + handlers: the units whose files become components */
    shown: Set<EdgeUnit>;
    filesShown: string[];
    /** file → component id */
    compOfFile: Map<string, string>;
    /** route → endpoint id */
    endpointOf: Map<EdgeRoute, string>;
    /** name → schema json */
    contractSchemas: Map<string, unknown>;
    extUsed: Set<string>;
}

export function makeEdgeCtx(input: EdgeInput): EdgeCtx {
    const { analysis, config } = input;
    const { routes } = analysis;
    const portExt = new Map<string, string>();
    for (const [key, x] of Object.entries(config.EXTERNALS)) for (const p of x.ports ?? []) portExt.set(p, key);
    return {
        ...input,
        units: analysis.units,
        routes,
        REPO_ID: config.REPO.id,
        APP: `${config.ID}.edge`,
        b: specBuilder(),
        unresolved: [],
        routeFns: new Set(routes.map((r) => r.fn)),
        fnDomain: new Map(),
        portExt,
        matchRoute: routeMatcher(routes.map((r) => ({ full: fullOf(r).replace(/\/$/, '') || '/', method: r.method, value: r }))),
        handlers: new Set(routes.map((r) => r.handler).filter((h): h is EdgeUnit => Boolean(h))),
        relevant: new Set(),
        shown: new Set(),
        filesShown: [],
        compOfFile: new Map(),
        endpointOf: new Map(),
        contractSchemas: new Map(),
        extUsed: new Set(),
    };
}

export const src = (c: EdgeCtx, file: string, line: number | undefined): Site => ({ repo: c.REPO_ID, file: `${FN_DIR}/${file}`, line: line || 1 });
/** `source` of a declared element or edge: `path` inside the project config, named by the config's `CONFIG_SOURCE`. */
export const cfgSrc = (c: EdgeCtx, path: string): ConfigSource => ({ config: `${c.config.CONFIG_SOURCE}#${path}` });

/** Which module a file of supabase/functions belongs to: a function's folder, a split shared folder, or its domain cluster. */
export function moduleOf(c: EdgeCtx, file: string): { id: string; name: string; parent: string; folder: string; domain?: string } {
    const parts = file.split('/');
    const t = parts[0];
    if (c.config.EDGE.SPLIT_SHARED.includes(t) && parts.length > 2) return { id: `${c.APP}.${seg(t)}.${seg(parts[1])}`, name: parts[1], parent: `${c.APP}.${seg(t)}`, folder: `${t}/${parts[1]}` };
    const d = c.fnDomain.get(t);
    if (d) return { id: `${c.APP}.${seg(d)}.${seg(t)}`, name: t, parent: `${c.APP}.${seg(d)}`, folder: t, domain: d };
    return { id: `${c.APP}.${seg(t)}`, name: t, parent: c.APP, folder: t };
}

// ---------- ids of the Supabase document ----------

export const tableId = (c: EdgeCtx, schema: string, table: string) => c.ids.tables.get(`${schema}.${table}`);
export const rpcId = (c: EdgeCtx, schema: string, fn: string) => c.ids.rpcs.get(`${schema}.${fn}`);
export const bucketId = (c: EdgeCtx, b: string) => c.ids.buckets.get(b);
const hostExt = (c: EdgeCtx, host: string): string | undefined => {
    const { EXTERNALS } = c.config;
    return Object.entries(EXTERNALS).find(([, x]) => (x.hosts ?? []).some((re) => re.test(host)))?.[0] ?? Object.entries(EXTERNALS).find(([, x]) => x.other)?.[0];
};

/** what a URL is: { route } of an Edge Function, { rest } (Data API), { ext, host }, or { none } */
export function urlTarget(c: EdgeCtx, url: string | null, method: string | undefined): UrlTarget {
    if (!url) return { none: 'dynamic-url' };
    let m: (string | null)[] | null = /\/functions\/v1(\/[^?#]*)/.exec(url);
    if (!m) {
        const first = /^\$\{\*\}(\/([^/?#]+)[^?#]*)/.exec(url);
        if (first && c.routeFns.has(first[2])) m = [null, first[1]];
        else if (first && first[2] === 'rest') return { rest: true };
    }
    if (m) {
        const path = m[1] as string; // the path group, in both forms
        const r = c.matchRoute(path, method);
        return r ? { route: r } : { none: 'unknown-route', path };
    }
    const host = /^https?:\/\/([^/:?#$]+)/.exec(url)?.[1];
    if (host) return { ext: hostExt(c, host), host };
    return { none: 'dynamic-url' };
}

/** an outside system that is reached: its element, added on first use */
export function extEl(c: EdgeCtx, key: string): string {
    const x = c.config.EXTERNALS[key];
    c.extUsed.add(key);
    return c.b.addEl({ id: x.id, type: 'external-system', parent: null, provenance: 'declared', name: x.name, technology: x.technology, source: cfgSrc(c, `EXTERNALS.${key}`) });
}
