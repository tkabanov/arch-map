// Boundary test, data half (docs/architecture.md AD-9): facets are optional detail. Strip every facet from
// every document, then the set must still validate and merge, and answer the same core questions:
// element / edge / method counts equal; every endpoint's Path steps identical; every table's readers and
// writers identical; every endpoint's callers identical; every scenario step resolves to the same edges; every
// scheduled job's Path identical; every element and edge identical apart from its facets (a stack's `via` routes and RLS `access` are core, not facets).
// Per project (<projects dir>/<name>/project.json, env ARCH_MAP_PROJECTS): its whole `documents` set, and its `open` set (what the viewer opens)
// must load on its own, with and without facets.
// Viewer half, static (AD-12): no code in viewer/src reads `facets` except spec-adapter.ts (shapeOf) and panel.ts
// (the generic «Code details» list). The browser half is `?nofacets=1` (spec-adapter.ts strips facets).
// Usage: node scripts/check-boundary.ts [<project> ...]             (default: every project)
//        node scripts/check-boundary.ts index.json | doc.json ...   one set from an index file and/or documents
// Problems print as `<file>:<line>: <message> (<id>)`; exit 1 on any.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatError } from './lib/spec-io.ts';
import { documentPaths, checkSpecSet } from './lib/spec-set.ts';
import { pickProjects, areProjectNames, noProjects } from './lib/projects.ts';
import { FACET_READERS, facetReadLines } from './lib/facet-guard.ts';
import { traceEndpoint, trace } from '../viewer/src/core/path.ts';
import { writers, readers, callers } from '../viewer/src/core/queries.ts';
import type { ArchMapSpecDocument } from '../types/spec.d.ts';
import type { MergedSet, ResolvedScenarios } from '../types/core.ts';
import type { SpecError } from '../types/generator.ts';

const stripFacets = (doc: ArchMapSpecDocument): ArchMapSpecDocument => {
    const strip = <T extends { facets?: unknown }>(x: T): Omit<T, 'facets'> => {
        const { facets: _f, ...rest } = x;
        return rest;
    };
    return { ...doc, elements: (doc.elements ?? []).map(strip), edges: (doc.edges ?? []).map(strip) };
};

// ---- viewer: facets are read only by the adapter and the panel ----
const viewerSrc = join(dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'src');
const tsFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? tsFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
const facetReads: string[] = [];
for (const file of tsFiles(viewerSrc)) {
    for (const line of facetReadLines(relative(viewerSrc, file), readFileSync(file, 'utf8'))) {
        facetReads.push(`${relative(process.cwd(), file)}:${line}: reads facets outside spec-adapter.ts / panel.ts`);
    }
}
if (facetReads.length) {
    for (const f of facetReads) console.error(f);
    console.error(`check-boundary: ${facetReads.length} facet read(s) in the viewer outside the adapter and the panel`);
    process.exit(1);
}


const args = process.argv.slice(2);
if (args.length && !areProjectNames(args)) {
    const pathErrors: SpecError[] = [];
    console.log(`check-boundary: ok — ${boundary(documentPaths(args, pathErrors), pathErrors)}`);
} else {
    const picked = pickProjects(args, 'check-boundary');
    if (!picked.length) console.log(`check-boundary: ${noProjects()}: no spec set to check`);
    for (const p of picked) {
        const label = `${p.name}: `;
        const summary = boundary(p.documents.map((d) => join(p.specsDir, d)), [], label);
        // the set the viewer opens: its `requires` stay inside it, with and without facets
        const open = p.open.length === p.documents.length ? 'the open set is the whole set' : `the open set (${p.open.length} documents) loads alone`;
        if (p.open.length !== p.documents.length) loadsAlone(p.open.map((n) => join(p.specsDir, n)), `${label}the open set (${p.open.join(', ')})`);
        console.log(`check-boundary: ${label}ok — ${summary}; ${open}`);
    }
}
console.log(`check-boundary: viewer reads facets only in ${[...FACET_READERS].join(', ')}`);

/** A subset loads on its own (its `requires` stay inside it), with and without facets; exits 1 if not. */
function loadsAlone(setPaths: string[], what: string): void {
    const setErrors = [...checkSpecSet(setPaths).errors, ...checkSpecSet(setPaths, { transform: stripFacets }).errors.map((e) => ({ ...e, message: `without facets: ${e.message}` }))];
    if (!setErrors.length) return;
    for (const e of setErrors) console.error(formatError(e));
    console.error(`check-boundary: ${setErrors.length} error(s) — ${what} does not load on its own`);
    process.exit(1);
}

/** Loads a set with and without facets and compares the core answers; exits 1 on any problem, else returns the summary. */
function boundary(paths: string[], pathErrors: SpecError[], label = ''): string {
    const full = checkSpecSet(paths);
    const bare = full.errors.length ? null : checkSpecSet(paths, { transform: stripFacets });
    const errors = [...pathErrors, ...full.errors, ...(bare?.errors ?? []).map((e) => ({ ...e, message: `without facets: ${e.message}` }))];
    if (errors.length || !bare) {
        for (const e of errors) console.error(formatError(e));
        console.error(`check-boundary: ${label}${errors.length} error(s) — the specs do not load${bare ? ' without facets' : ''}`);
        process.exit(1);
    }
    // both sets loaded (errors exit above)
    const a = full.merged!;
    const b = bare.merged!;
    const facetCount = (m: MergedSet): number => m.elements.filter((e) => e.facets).length + m.edges.filter((e) => e.facets).length;
    const methodCount = (m: MergedSet): number => m.elements.reduce((n, e) => n + (e.methods?.length ?? 0), 0);
    const diffs: string[] = [];
    const same = (what: string, x: unknown, y: unknown): void => {
        if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(what);
    };

    same('element count', a.elements.length, b.elements.length);
    same('edge count', a.edges.length, b.edges.length);
    same('method count', methodCount(a), methodCount(b));
    const core = (x: { facets?: unknown }): string => {
        const { facets: _f, ...rest } = x;
        return JSON.stringify(rest);
    };
    const bareEl = new Map(b.elements.map((e) => [e.id, core(e)]));
    const bareEdge = new Map(b.edges.map((e) => [e.id, core(e)]));
    for (const e of a.elements) if (bareEl.get(e.id) !== core(e)) diffs.push(`element ${e.id}`);
    for (const e of a.edges) if (bareEdge.get(e.id) !== core(e)) diffs.push(`edge ${e.id}`);
    const routed = a.edges.filter((e) => e.via?.length).length;
    const guarded = a.edges.filter((e) => e.access?.policies?.length).length;

    const endpoints = a.elements.filter((e) => e.type === 'endpoint');
    let pathSteps = 0;
    let breaks = 0;
    for (const ep of endpoints) {
        const pa = traceEndpoint(a, ep.id);
        pathSteps += pa.length;
        breaks += pa.filter((s) => s.channel === 'break').length;
        same(`Path of ${ep.id}`, pa, traceEndpoint(b, ep.id));
        same(`callers of ${ep.id}`, callers(a, ep.id, { methods: true }), callers(b, ep.id, { methods: true }));
    }
    // the client apps (an app of tier ui, such as a React client app) have no endpoints: Path of each method of
    // their screens, pages and API components
    const appOf = (id: string) => {
        let e = a.byId.get(id);
        while (e && e.type !== 'app') e = e.parent ? a.byId.get(e.parent) : undefined;
        return e;
    };
    const clientMethods = a.elements.filter((e) => e.methods?.length && appOf(e.id)?.tier === 'ui').flatMap((e) => e.methods!.map((m) => [e.id, m.name]));
    let clientSteps = 0;
    for (const [id, m] of clientMethods) {
        const pa = trace(a, id, m);
        clientSteps += pa.length;
        same(`Path of ${id}#${m}`, pa, trace(b, id, m));
    }
    // job rails (pg_cron): no methods of their own; each job is the `fromMethod` of its `schedule` edges, a Path entry point
    const jobRuns = [...new Set(a.edges.filter((e) => e.channel === 'schedule' && e.fromMethod && a.byId.get(e.from)?.type === 'job').map((e) => `${e.from}#${e.fromMethod}`))].sort();
    let jobSteps = 0;
    for (const run of jobRuns) {
        const [id, m] = run.split('#');
        const pa = trace(a, id, m);
        jobSteps += pa.length;
        same(`Path of ${run}`, pa, trace(b, id, m));
    }
    const cycles = [...endpoints.map((ep) => traceEndpoint(a, ep.id)), ...clientMethods.map(([id, m]) => trace(a, id, m)), ...jobRuns.map((r) => trace(a, ...(r.split('#') as [string, string])))].reduce(
        (n, steps) => n + steps.filter((s) => s.cycle).length,
        0,
    );
    const tables = a.elements.filter((e) => e.type === 'table');
    for (const t of tables) {
        same(`writers of ${t.id}`, writers(a, t.id), writers(b, t.id));
        same(`readers of ${t.id}`, readers(a, t.id), readers(b, t.id));
    }
    const stepEdges = (scenarios: ResolvedScenarios['scenarios']) => scenarios.map((s) => s.resolved.map((r) => [r.kind, (r as { element?: string }).element ?? null, r.edges.map((e) => e.id), r.contract]));
    same('scenario resolution', stepEdges(full.scenarios!), stepEdges(bare.scenarios!));
    const resolvedSteps = full.scenarios!.reduce((n, s) => n + s.resolved.length, 0);

    if (diffs.length) {
        for (const d of diffs.slice(0, 50)) console.error(`check-boundary: ${label}differs without facets — ${d}`);
        console.error(`check-boundary: ${label}${diffs.length} difference(s)`);
        process.exit(1);
    }
    return (
        `${facetCount(a)} faceted items stripped; equal without facets: ${a.elements.length} elements, ` +
        `${a.edges.length} edges (core fields of each, incl. ${routed} \`via\` routes and ${guarded} RLS policy lists), ${methodCount(a)} methods; ` +
        `Path of ${endpoints.length} endpoints (${pathSteps} steps, ${breaks} breaks); ` +
        `Path of ${clientMethods.length} client methods (${clientSteps} steps); ` +
        `Path of ${jobRuns.length} scheduled jobs (${jobSteps} steps); ${cycles} cycle steps; ` +
        `callers of ${endpoints.length} endpoints; readers/writers of ${tables.length} tables; ${full.scenarios!.length} scenario(s), ${resolvedSteps} steps resolved`
    );
}
