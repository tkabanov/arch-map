// Turns the generator's analysis of a Nest backend and its frontends into a spec document (`DOC` of the project config) (docs/architecture.md
// AD-3..AD-7). Element ids are stable across runs (AD-6); calls, data access,
// events and outbound HTTP are emitted per method (AD-4); REST contracts sit on endpoint elements (AD-7); in-process
// events go through `bus` elements.
// Returns { doc, unresolved, stats }; writing and validation are spec-io.ts's job.
import type { ArchMapSpecDocument, Channel, CodeSource, Edge, Facets, Repo, Site } from '../../../types/spec.d.ts';
import type { UnresolvedEntry } from '../../../types/generator.ts';
import type { NestAnalysis } from '../../../types/stacks/nest.ts';
import { bySite, cfgSource, clean, cmp, makeCtx, readOperations, type BuildCtx } from './to-spec-ctx.ts';
import { addApiTree, addBackendRoot, addBuses, addContextModules, addDataElements } from './to-spec-api.ts';
import {
    addClassLevelEdges, addExternalClientClasses, addForeignKeyEdges, addInboundEdges, addInheritedMethods, addMethodEdges, addMethodEntries, attachMethods,
} from './to-spec-methods.ts';
import { addFrontends } from './to-spec-frontend.ts';
import { NEST_GLYPHS } from './glyphs.ts';

export { ident } from './to-spec-ctx.ts';

// ---------- finalize edges ----------

function finalizeEdges(c: BuildCtx): Edge[] {
    const outEdges: Edge[] = [];
    for (const acc of c.edges.values()) {
        const sites = [...acc.sites.values()].sort(bySite);
        const e: Partial<Edge> = { id: acc.id, from: acc.from, to: acc.to, channel: acc.channel as Channel, fromMethod: acc.fromMethod, toMethod: acc.toMethod, label: acc.label };
        if (acc.routes) e.label = [...acc.routes].sort(cmp).join(', ');
        if (acc.ops.size) e.ops = [...acc.ops].sort(cmp);
        if (acc.declared) {
            e.provenance = 'declared';
            e.source = cfgSource(c, acc.declared);
            if (sites.length) e.sites = sites;
        } else {
            e.provenance = 'extracted';
            e.source = sites[0];
            if (sites.length > 1) e.sites = sites;
        }
        if (acc.contracts.size === 1) e.contract = [...acc.contracts.values()][0];
        if (acc.facets) e.facets = acc.facets as Facets;
        if (acc.fkList) e.facets = { 'sequelize.fk': { fields: acc.fkList.sort((a, b) => cmp(a.field, b.field) || cmp(a.rel, b.rel)) } };
        outEdges.push(clean(e) as Edge); // provenance is set in both branches above
    }
    return outEdges;
}

// ---------- unresolved report ----------

function addUnresolvedReport(c: BuildCtx): void {
    const { buses, edges, elements, unresolved } = c;
    for (const e of edges.values()) for (const id of [e.from, e.to]) if (buses.has(id)) buses.get(id)!.edges++;
    for (const [id, b] of buses) {
        if (b.edges) continue;
        const el = elements.get(id)!;
        const src = el.source as Partial<CodeSource> | undefined; // a config source has no file
        unresolved.push({ kind: 'idle-bus', element: id, ...(src?.file ? { repo: src.repo, file: src.file, line: src.line } : {}), expr: `${el.name}: nothing in the slice publishes to it or subscribes to it` });
    }
    for (const p of c.packageClients.values()) unresolved.push({ ...p, calls: [...p.calls].sort(cmp) });
    for (const u of c.x.unmatched) unresolved.push({ kind: 'unmatched-route', repo: u.repo, file: u.file, line: u.line, expr: `${u.method ?? '?'} /${u.path}` });
    // TODO(types): an entry without a location (an idle bus from config) compares with undefined fields, as it always did
    unresolved.sort((a, b) => cmp(a.kind, b.kind) || bySite(a as Site, b as Site) || cmp(a.expr, b.expr));
}

function repoTable(x: NestAnalysis): Record<string, Repo> {
    const { BACKEND, FRONTENDS } = x.config;
    const repos: Record<string, Repo> = {};
    for (const app of [BACKEND, ...FRONTENDS]) {
        const commit = x.commits[app.id];
        const blob = (app.blobUrl ?? `${app.repoUrl}/blob/{commit}/{file}#L{line}`).replaceAll('{commit}', commit);
        repos[app.id] = { url: app.repoUrl, commit, blob };
    }
    return repos;
}

export function buildSpec(x: NestAnalysis): { doc: ArchMapSpecDocument; unresolved: UnresolvedEntry[]; stats: { classLevelEdges: number } } {
    const c = makeCtx(x);
    readOperations(c); // contracts (AD-7)
    addBackendRoot(c);
    addBuses(c);
    addApiTree(c);
    addMethodEntries(c);
    addMethodEdges(c);
    addInheritedMethods(c);
    addExternalClientClasses(c);
    addInboundEdges(c);
    addForeignKeyEdges(c);
    addFrontends(c);
    const classLevelEdges = addClassLevelEdges(c);
    addDataElements(c);
    addContextModules(c);
    attachMethods(c);
    const outEdges = finalizeEdges(c);
    addUnresolvedReport(c);

    const doc: ArchMapSpecDocument = {
        schemaVersion: '1.3.0',
        id: x.config.DOC.id,
        title: x.config.DOC.title,
        repos: repoTable(x),
        glyphs: NEST_GLYPHS.map((g) => ({ ...g })),
        elements: [...c.elements.values()],
        edges: outEdges,
    };
    return { doc, unresolved: c.unresolved, stats: { classLevelEdges } };
}
