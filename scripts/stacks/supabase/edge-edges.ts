// `buildEdgeSpec`, the edges: per unit (calls, tables, RPCs, buckets, outside ports, HTTP), the calls out of Postgres
// into Edge Functions, the webhooks of outside systems, and the gateway in front of /functions/v1.
import { supabaseVia } from './ids.ts';
import type { DbHttpCall, EdgeUnit, SupabaseVia } from '../../../types/stacks/supabase.ts';
import { FN_DIR, bucketId, cfgSrc, extEl, fullOf, rpcId, src, tableId, urlTarget, type EdgeCtx } from './edge-ctx.ts';

/** The unit an edge starts from, with the helpers that make its sites. */
interface UnitScope {
    u: EdgeUnit;
    from: string;
    fromMethod: string;
    via: SupabaseVia;
}

const siteIn = (c: EdgeCtx, u: EdgeUnit, line: number) => src(c, u.file, line);

function callEdges(c: EdgeCtx, s: UnitScope): void {
    const { u } = s;
    for (const { target, line } of u.calls.values()) {
        if (!c.shown.has(target) || !c.relevant.has(target)) continue; // into pure helpers: not a step of any path
        c.b.addEdge({ from: s.from, fromMethod: s.fromMethod, to: c.compOfFile.get(target.file), toMethod: target.name, channel: 'call', site: siteIn(c, u, line), source: siteIn(c, u, line) });
    }
}

function tableEdges(c: EdgeCtx, s: UnitScope): void {
    const { u } = s;
    for (const t of u.tables.values()) {
        const to = tableId(c, t.schema, t.table);
        if (!to) {
            c.unresolved.push({ kind: 'unknown-table', repo: c.REPO_ID, file: `${FN_DIR}/${u.file}`, line: t.line, element: s.from, method: u.name, expr: `.from('${t.table}').${t.op}() — not in the ${t.schema} schema of the snapshot` });
            continue;
        }
        c.b.addEdge({ from: s.from, fromMethod: s.fromMethod, to, channel: t.op === 'select' ? 'read' : 'write', ops: [t.op], via: s.via.REST, site: siteIn(c, u, t.line), source: siteIn(c, u, t.line) });
    }
}

function rpcEdges(c: EdgeCtx, s: UnitScope): void {
    const { u } = s;
    for (const r of u.rpcs.values()) {
        const to = rpcId(c, r.schema, r.fn);
        if (!to) {
            c.unresolved.push({ kind: 'unknown-rpc', repo: c.REPO_ID, file: `${FN_DIR}/${u.file}`, line: r.line, element: s.from, method: u.name, expr: `.rpc('${r.fn}') — no such RPC in the snapshot` });
            continue;
        }
        c.b.addEdge({ from: s.from, fromMethod: s.fromMethod, to, channel: 'rest', label: `rpc ${r.fn}`, via: s.via.REST, site: siteIn(c, u, r.line), source: siteIn(c, u, r.line) });
    }
}

function storageAndPortEdges(c: EdgeCtx, s: UnitScope): void {
    const { u } = s;
    for (const b of u.buckets.values()) {
        const to = bucketId(c, b.bucket);
        if (to) c.b.addEdge({ from: s.from, fromMethod: s.fromMethod, to, channel: b.access, ops: [b.op], via: s.via.STORAGE, site: siteIn(c, u, b.line), source: siteIn(c, u, b.line) });
    }
    for (const p of u.ports.values()) {
        const key = c.portExt.get(p.port);
        if (!key) continue;
        c.b.addEdge({ from: s.from, fromMethod: s.fromMethod, to: extEl(c, key), channel: 'https', ops: [p.method], site: siteIn(c, u, p.line), source: siteIn(c, u, p.line) });
    }
}

function httpEdges(c: EdgeCtx, s: UnitScope): void {
    const { u } = s;
    const at = { from: s.from, fromMethod: s.fromMethod };
    for (const h of u.http) {
        const t = urlTarget(c, h.url, h.method);
        if (t.route && c.endpointOf.has(t.route)) c.b.addEdge({ ...at, to: c.endpointOf.get(t.route), channel: 'rest', label: `${t.route.method} ${t.route.basePath}${t.route.path ?? ''}`, via: s.via.GW, site: siteIn(c, u, h.line), source: siteIn(c, u, h.line) });
        else if (t.rest) c.b.addEdge({ ...at, to: c.config.SUPABASE_SERVICES.rest.id, channel: 'rest', label: '/rest/v1', via: s.via.GW, site: siteIn(c, u, h.line), source: siteIn(c, u, h.line) });
        else if (t.ext) c.b.addEdge({ ...at, to: extEl(c, t.ext), channel: 'https', ops: [t.host!], site: siteIn(c, u, h.line), source: siteIn(c, u, h.line) });
        // a route without an endpoint (its handler's file is not shown) or a host no outside system claims has no `none`
        else c.unresolved.push({ kind: t.none ?? (t.route ? 'route-without-endpoint' : 'unknown-host'), repo: c.REPO_ID, file: `${FN_DIR}/${u.file}`, line: h.line, element: s.from, method: u.name, expr: `${h.method ?? ''} ${h.url ?? h.expr}`.trim() });
    }
}

/** how a call travels (Edge Function to Edge Function): supabase-js talks HTTP to SUPABASE_URL — the gateway, then
 *  PostgREST for .from()/.rpc() and the Storage API for .storage; calls to /functions/v1 pass the gateway too */
export function addUnitEdges(c: EdgeCtx): void {
    const via = supabaseVia(c.ids);
    for (const u of c.shown) {
        const s: UnitScope = { u, from: c.compOfFile.get(u.file)!, fromMethod: u.name, via };
        callEdges(c, s);
        tableEdges(c, s);
        rpcEdges(c, s);
        storageAndPortEdges(c, s);
        httpEdges(c, s);
        for (const x of u.unresolved) c.unresolved.push({ kind: x.kind, repo: c.REPO_ID, file: `${FN_DIR}/${u.file}`, line: x.line, element: s.from, method: u.name, expr: x.expr });
    }
}

/** what the Postgres side calls (pg_net in functions, HTTP cron jobs): resolved here, where the routes are known */
export function addDbHttpEdges(c: EdgeCtx): Set<DbHttpCall> {
    const VIA_GW = supabaseVia(c.ids).GW;
    const resolvedDbHttp = new Set<DbHttpCall>();
    for (const h of c.dbHttp) {
        const t = urlTarget(c, h.url, 'POST');
        if (!t.route || !c.endpointOf.has(t.route)) continue;
        resolvedDbHttp.add(h);
        c.b.addEdge({ from: h.from, fromMethod: h.fromMethod, to: c.endpointOf.get(t.route), channel: h.channel, label: h.label ?? `${t.route.method} ${t.route.basePath}${t.route.path ?? ''}`, via: VIA_GW, source: h.source });
    }
    return resolvedDbHttp;
}

/** webhooks of outside systems */
export function addWebhookEdges(c: EdgeCtx): void {
    for (const r of c.routes) {
        const full = fullOf(r);
        const ib = c.config.INBOUND.find((x) => full.startsWith(x.path) || full === x.path.replace(/\/$/, ''));
        if (!ib || !c.endpointOf.has(r)) continue;
        c.b.addEdge({ from: extEl(c, ib.from), to: c.endpointOf.get(r), channel: 'webhook', provenance: 'declared', source: cfgSrc(c, 'INBOUND') });
    }
}

/** the gateway serves /functions/v1 */
export function addGatewayEdge(c: EdgeCtx): void {
    const gw = c.tomlAt('edge_runtime');
    if (c.ids.gateway && gw) c.b.addEdge({ from: c.ids.gateway, to: c.APP, channel: 'rest', label: '/functions/v1', source: gw });
}
