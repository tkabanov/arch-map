// A Supabase project's Edge Functions as a spec document, from the analysis of edge.ts and the ids of
// the Supabase document (tables, RPC endpoints, buckets). A module per Edge Function, a component per file that serves
// a route or reaches something (a table, an RPC, a bucket, an outside system, another Edge Function) — pure helpers
// stay out; a method per such function. Also the HTTP calls from Postgres and pg_cron into Edge Functions, the inbound
// webhooks of outside systems, and the contracts of the project's own OpenAPI with its schemas named after the DTOs.
// Pure: in → { doc, contracts, unresolved, resolvedDbHttp, stats }.

import { cmp } from '../../lib/spec-build.ts';
import type { ArchMapSpecDocument } from '../../../types/spec.d.ts';
import type { UnresolvedEntry } from '../../../types/generator.ts';
import type { DbHttpCall } from '../../../types/stacks/supabase.ts';
import { makeEdgeCtx, type EdgeCtx, type EdgeInput } from './edge-ctx.ts';
import { addComponents, addEdgeApp, addEndpoints, addModules, assignEdgeDomains, selectRelevant } from './edge-elements.ts';
import { addDbHttpEdges, addGatewayEdge, addUnitEdges, addWebhookEdges } from './edge-edges.ts';

/** The project's own OpenAPI with its schemas named after the DTOs (null without one). */
function contractsOf(c: EdgeCtx): Record<string, unknown> | null {
    const { openapi } = c;
    return openapi && {
        openapi: openapi.openapi, info: { ...openapi.info, description: 'The project\'s own OpenAPI (supabase/functions/openapi/schema.ts); request and response bodies named after their DTOs in components.schemas.' },
        servers: openapi.servers,
        components: { schemas: Object.fromEntries([...c.contractSchemas].sort((a, b) => cmp(a[0], b[0]))) },
    };
}

export function buildEdgeSpec(input: EdgeInput): {
    doc: ArchMapSpecDocument;
    contracts: Record<string, unknown> | null;
    unresolved: UnresolvedEntry[];
    resolvedDbHttp: Set<DbHttpCall>;
    stats: Record<string, unknown>;
} {
    const c = makeEdgeCtx(input);
    // ---------- relevance: which units matter, and the domain of each function ----------
    selectRelevant(c);
    assignEdgeDomains(c);
    // ---------- elements ----------
    addEdgeApp(c);
    const modules = addModules(c);
    addComponents(c, modules);
    addEndpoints(c);
    // ---------- edges ----------
    addUnitEdges(c);
    const resolvedDbHttp = addDbHttpEdges(c);
    addWebhookEdges(c);
    addGatewayEdge(c);

    // ---------- out ----------
    // a domain cluster has no line of its own: it points where its first part is
    const byId = [...c.b.elements.values()].sort((a, b) => cmp(a.id, b.id));
    for (const el of byId) if (!el.source) el.source = byId.find((x) => x.source && x.id.startsWith(`${el.id}.`))?.source;
    const edgeList = c.b.finishEdges();
    c.unresolved.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || cmp(a.expr, b.expr));
    const { REPO } = c.config;
    const doc: ArchMapSpecDocument = {
        schemaVersion: '1.2.0',
        id: c.config.DOCS.edge.id,
        title: c.config.DOCS.edge.title,
        requires: [`${c.config.DOCS.supabase.id}.json`],
        repos: c.commit ? { [c.REPO_ID]: { url: REPO.url, commit: c.commit, blob: `${REPO.url}/blob/${c.commit}/{file}#L{line}` } } : {},
        elements: [...c.b.elements.values()],
        edges: edgeList,
    };
    return {
        doc, contracts: contractsOf(c), unresolved: c.unresolved, resolvedDbHttp,
        stats: { units: c.units.length, relevant: c.relevant.size, shown: c.shown.size, files: c.filesShown.length, routes: c.routes.length, endpoints: c.endpointOf.size, externals: [...c.extUsed].sort() },
    };
}
