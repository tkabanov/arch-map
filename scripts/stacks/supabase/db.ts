// A Supabase project as a spec document: the database from a read-only snapshot of one environment
// (tables, views, functions and what their bodies read, write and call, triggers, foreign keys, RLS, pg_cron) and the
// Supabase services around it, taken from supabase/config.toml and the same snapshot (Data API = PostgREST with the
// grants and RLS policies that decide who reaches each table, Auth with its triggers on auth.users, Storage with its
// buckets and policies, Realtime with its publication, the API gateway in front of them).
// Every fact points at where it was taken from: a migration of the repo when the object is found there, else its line
// in the snapshot file (repo `snapshot`, commit = a hash of the file); services point at supabase/config.toml.
// Pure: { snap, config, index, toml, commit, snapAt, snapFile, snapHash } in, { doc, unresolved, stats } out.
import type { ArchMapSpecDocument } from '../../../types/spec.d.ts';
import type { UnresolvedEntry } from '../../../types/generator.ts';
import type { DbHttpCall, Domains } from '../../../types/stacks/supabase.ts';
import { cmp, makeDbCtx, type DbCtx, type DbInput, type Skipped } from './db-ctx.ts';
import { addAuthUsers, addDatabase, addReferenceEdges, addTables, addViews } from './db-schema.ts';
import { addCron, addFunctionEdges, addFunctions, addFunctionsModule, addTriggers, assignDomains, groupFunctions, splitLargeGroups } from './db-functions.ts';
import { addAuthRealtimeEdges, addBuckets, addDataApiEdges, addPlatformEdges, addRpcEdges, addServices, addStorageSchema } from './db-platform.ts';

/** a grouping (schema, name word) has no line of its own: it points where its first part is */
function sourceGroupings(c: DbCtx): void {
    const byId = [...c.elements.values()].sort((a, b) => cmp(a.id, b.id));
    for (const el of byId) {
        if (el.source) continue;
        const first = byId.find((x) => x.source && x.id.startsWith(`${el.id}.`));
        if (first) el.source = first.source;
    }
}

function tidyEdges(c: DbCtx): void {
    for (const e of c.edges.values()) if (!e.ops!.length) delete e.ops;
    // `ops` only on data and outside-system edges (schema); a call or trigger carries none
    for (const e of c.edges.values()) if (e.ops && !['read', 'write', 'references', 'https', 'smtp'].includes(e.channel)) delete e.ops;
}

function assembleDoc(c: DbCtx): ArchMapSpecDocument {
    const { snap, config, commit, snapFile, snapHash, REPO_ID } = c;
    const { REPO } = config;
    return {
        schemaVersion: '1.2.0',
        id: config.DOCS.supabase.id,
        tiers: config.TIERS,
        title: `${config.DOCS.supabase.title} (database from a ${snap.env} snapshot; services from supabase/config.toml)`,
        repos: {
            ...(commit ? { [REPO_ID]: { url: REPO.url, commit, blob: `${REPO.url}/blob/${commit}/{file}#L{line}` } } : {}),
            snapshot: { url: snapFile, commit: snapHash, blob: '{file}#L{line}' },
        },
        elements: [...c.elements.values()],
        edges: [...c.edges.values()],
    };
}

export function buildSupabaseSpec(input: DbInput): {
    doc: ArchMapSpecDocument;
    unresolved: UnresolvedEntry[];
    httpCalls: DbHttpCall[];
    domains: Domains;
    stats: { skipped: Skipped; groups: Record<string, number>; rules: Record<string, number> };
} {
    const c = makeDbCtx(input);
    // ---------- the database ----------
    addDatabase(c);
    addTables(c);
    addViews(c);
    addAuthUsers(c);
    addReferenceEdges(c);
    // ---------- functions, what each does, triggers, pg_cron ----------
    groupFunctions(c);
    assignDomains(c);
    addFunctionsModule(c);
    splitLargeGroups(c);
    addFunctions(c);
    addFunctionEdges(c);
    addTriggers(c);
    addCron(c);
    // ---------- the Supabase platform (config SUPABASE_SERVICES, after Supabase's architecture page) ----------
    const services = addServices(c);
    addPlatformEdges(c, services);
    addStorageSchema(c, services);
    addDataApiEdges(c, services);
    addRpcEdges(c, services);
    addAuthRealtimeEdges(c, services);
    addBuckets(c, services);
    // ---------- out ----------
    sourceGroupings(c);
    tidyEdges(c);
    c.unresolved.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.element ?? '', b.element ?? '') || cmp(a.expr, b.expr));
    const doc = assembleDoc(c);
    const { assigned } = c;
    const groups = Object.fromEntries([...new Set([...assigned.values()].map((a) => a.group))].sort().map((g) => [g, [...assigned.values()].filter((a) => a.group === g).length]));
    return { doc, unresolved: c.unresolved, httpCalls: c.httpCalls, domains: c.domains, stats: { skipped: c.skipped, groups, rules: Object.fromEntries(['name', 'table', 'trigger', 'none', 'small'].map((r) => [r, [...assigned.values()].filter((a) => a.rule === r).length])) } };
}
