// A React + supabase-js client app as a spec document, from the analysis of react-client.ts and the
// ids of the Supabase and Edge Functions documents. App `<ID>.cand` (an overlay's system may claim it):
// a module per feature with a component per route screen (the `lazy` target; a method = its exported component), the
// app shell (src/app) where it reaches the API, and the API: a component per domain of src/api/resources (methods = the
// port methods whose live adapter does something) and the seam src/api/live (ownTask …). Edges:
//   screen#Component → api.<domain>#<port method> :call   (hook → queries → port, any number of hops)
//   api.<domain>#m → table :read/:write (ops)             via gateway → PostgREST, with the Data API's RLS access
//   api.<domain>#m → RPC endpoint / Edge Function endpoint :rest, → Auth :rest, → outside system :https
//   api.<domain>#m → api.<other>#m / seam#m :call
// Stub port methods («scheduled in story …») and screens' calls of them go to the unresolved report, never to edges.
// Pure: in → { doc, unresolved, stats }.
import { cmp, seg, specBuilder } from '../../lib/spec-build.ts';
import { supabaseVia, routeMatcher } from './ids.ts';
import type { ArchMapSpecDocument, ConfigSource, Edge, Element, Site } from '../../../types/spec.d.ts';
import type { UnresolvedEntry } from '../../../types/generator.ts';
import type { ReactClientAnalysis, CandEffect, CandPort, CandRoot, CandRoute, CandSeam, SupabaseIds, SupabaseConfig } from '../../../types/stacks/supabase.ts';

/** Where an Edge Function call goes: its endpoint, or why there is none. */
interface EdgeTarget {
    ep?: Element;
    none?: string;
    candidates?: string[];
    path?: string;
}

const snake = (s: unknown): string => seg(String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2'));

export function buildReactClientSpec({ analysis, config, ids, edgeDoc, supaDoc, commit }: {
    analysis: ReactClientAnalysis;
    config: SupabaseConfig;
    ids: SupabaseIds;
    edgeDoc: ArchMapSpecDocument | null | undefined;
    supaDoc: ArchMapSpecDocument | null | undefined;
    commit: string | null;
}): { doc: ArchMapSpecDocument; unresolved: UnresolvedEntry[]; stats: Record<string, unknown> } {
    const C = config.REACT_CLIENT;
    const EXTERNALS: Record<string, { id: string; name: string; technology: string; hosts: RegExp[] }> = C.EXTERNALS;
    const REPO_ID = C.repo.id;
    /** the app (`<ID>.cand`): the root of every id of the document */
    const APP = `${config.ID}.cand`;
    const src = (file: string, line: number | undefined): Site => ({ repo: REPO_ID, file, line: line || 1 });
    const cfgSrc = (path: string): ConfigSource => ({ config: `${config.CONFIG_SOURCE}#${path}` });
    const { elements, addEl, addEdge, finishEdges } = specBuilder();
    const unresolved: UnresolvedEntry[] = [];
    const VIA = supabaseVia(ids);
    const tableId = (schema: string, table: string) => ids.tables.get(`${schema}.${table}`);
    const rpcId = (fn: string) => ids.rpcs.get(`public.${fn}`);
    const endpoints = (edgeDoc?.elements ?? []).filter((e) => e.type === 'endpoint' && e.http);
    const matchEdge = routeMatcher(endpoints.map((e) => ({ full: e.http!.path, method: e.http!.method, value: e })), { preferLiteral: true });
    /** what anon / authenticated reach through the Data API (PostgREST > table): the client's request runs under it */
    const dataApi = new Map((supaDoc?.edges ?? []).filter((e) => e.from === ids.rest).map((e): [string, Edge] => [`${e.to}|${e.channel}`, e]));
    const hostExt = (host: string): string | undefined => Object.entries(EXTERNALS).find(([, x]) => x.hosts.some((re) => re.test(host)))?.[0];

    // ---------- which port methods do something (directly, or by calling one that does) ----------
    const ports = new Map(analysis.ports.map((p) => [p.key, p]));
    const seam = new Map(analysis.seam.map((s) => [s.key, s]));
    const edgeTarget = (e: Extract<CandEffect, { kind: 'edge' }>): EdgeTarget => {
        const name = e.name?.value;
        if (typeof name !== 'string') return { none: e.name?.union ? 'dynamic-edge' : 'dynamic-edge', candidates: e.name?.union };
        const ep = matchEdge(`/${name}`, e.method);
        return ep ? { ep } : { none: 'unknown-route', path: `${e.method ?? ''} /${name}`.trim() };
    };
    const resolves = (e: CandEffect) =>
        (e.kind === 'table' && tableId(e.schema, e.table)) ||
        (e.kind === 'rpc' && rpcId(e.fn)) ||
        (e.kind === 'edge' && edgeTarget(e).ep) ||
        (e.kind === 'auth' && ids.auth) ||
        (e.kind === 'fetch' && e.url && /^https?:\/\/([^/:?#$]+)/.exec(e.url) && hostExt(/^https?:\/\/([^/:?#$]+)/.exec(e.url)![1]));
    const effective = new Set<string | undefined>();
    for (const x of [...ports.values(), ...seam.values()]) if (x.effects.some(resolves)) effective.add(x.key);
    for (let changed = true; changed; ) {
        changed = false;
        for (const x of [...ports.values(), ...seam.values()]) {
            if (effective.has(x.key)) continue;
            if (x.calls.some((c) => effective.has(c.port ?? c.seam))) {
                effective.add(x.key);
                changed = true;
            }
        }
    }

    // ---------- elements ----------
    const routesFile = `${C.SRC}/${C.ROUTES}`;
    addEl({
        id: APP, type: 'app', parent: null, tier: 'ui', provenance: 'extracted', name: C.APP.name, technology: C.APP.technology,
        description: C.APP.description,
        source: src(routesFile, analysis.routes[0]?.line ?? 1),
        facets: { 'react.app': { router: 'react-router (data router, lazy routes)', routes: analysis.routes.length, apiMode: 'VITE_API_MODE=live' }, 'supabase.client': { key: 'publishable (anon)', session: 'user JWT', rls: 'applies' } },
    });
    const domComp = (d: string): string => `${APP}.api.${seg(d)}`;
    const SEAM_ID = `${APP}.api.seam`;
    const shownPort = (k: string): boolean => effective.has(k) && ports.has(k);
    const domains = [...new Set([...ports.values()].filter((p) => shownPort(p.key)).map((p) => p.domain))].sort();
    const seamShown = [...seam.values()].filter((s) => effective.has(s.key));

    // screens and the app shell
    const routesOf = new Map<string, CandRoute[]>();
    for (const r of analysis.routes) (routesOf.get(r.screen) ?? routesOf.set(r.screen, []).get(r.screen)!).push(r);
    const featureOf = (f: string): string | undefined => /^src\/features\/([^/]+)\//.exec(f)?.[1];
    const rootComp = new Map<string, string>();
    const reachShown = (root: CandRoot) => root.reach.filter((x) => shownPort(x.port));
    const shownRoots = analysis.roots.filter((r) => r.kind === 'screen' || reachShown(r).length);
    for (const r of shownRoots) {
        const base = r.file.split('/').pop()!.replace(/\.tsx?$/, '');
        const mod = r.kind === 'screen' ? `${APP}.${seg(featureOf(r.file))}` : `${APP}.app`;
        rootComp.set(r.file, `${mod}.${snake(base)}`);
    }
    const mods = [...new Set([...rootComp.values()].map((id) => id.split('.').slice(0, -1).join('.')))].sort();
    for (const m of mods) {
        if (m === `${APP}.app`) addEl({ id: m, type: 'module', parent: APP, provenance: 'extracted', name: 'app shell', description: 'src/app: the shell, auth and onboarding providers, navigation — the parts that reach the API.', derivedFrom: { rule: 'folder', value: 'src/app' }, confidence: 'high' });
        else {
            const folder = shownRoots.find((r) => rootComp.get(r.file)!.startsWith(`${m}.`))!.file.split('/').slice(0, 3).join('/');
            addEl({ id: m, type: 'module', parent: APP, provenance: 'extracted', name: folder.split('/').pop(), description: `Screens of ${folder}/`, derivedFrom: { rule: 'folder', value: folder }, confidence: 'high' });
        }
    }
    if (domains.length || seamShown.length) addEl({ id: `${APP}.api`, type: 'module', parent: APP, provenance: 'extracted', name: 'api', description: 'src/api: a port per domain (resources/<domain>/types.ts), its live adapter (supabase-js) and the hooks the screens use; the seam live/ holds the one client and shared helpers.', derivedFrom: { rule: 'folder', value: 'src/api' }, confidence: 'high' });
    for (const r of [...shownRoots].sort((a, b) => cmp(rootComp.get(a.file)!, rootComp.get(b.file)!))) {
        const rs = routesOf.get(r.file) ?? [];
        const titles = [...new Set(rs.map((x) => x.title).filter(Boolean))];
        const base = r.file.split('/').pop()!.replace(/\.tsx?$/, '');
        const name = r.kind === 'app' ? base : titles.length === 1 ? titles[0] : `${base === 'Screen' ? featureOf(r.file) : base} (${rs.length} routes)`;
        addEl({
            id: rootComp.get(r.file)!, type: 'component', parent: rootComp.get(r.file)!.split('.').slice(0, -1).join('.'), provenance: 'extracted', name,
            technology: r.kind === 'screen' ? 'React route screen' : 'React component',
            description: r.kind === 'screen' ? `${r.file.split('/').pop()}: ${rs.map((x) => `${x.path}${x.title ? ` — ${x.title}` : ''}`).join('; ')}` : `${r.file}`,
            source: src(r.file, r.main.line), methods: [{ name: r.main.name, line: r.main.line }],
            facets: r.kind === 'screen' ? { 'react.route': { routes: rs.map((x) => ({ path: x.path, title: x.title, nav: x.nav })) } } : undefined,
        });
    }
    // the API: a component per domain, methods = port methods that do something
    for (const d of domains) {
        const ms = [...ports.values()].filter((p) => p.domain === d && shownPort(p.key)).sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
        addEl({
            id: domComp(d), type: 'component', parent: `${APP}.api`, provenance: 'extracted', name: d, technology: 'port + live adapter',
            description: `src/api/resources/${d}/: the port, its live adapter and hooks. ${[...ports.values()].filter((p) => p.domain === d && p.stub).length || 'No'} stub method(s) pending live.`,
            source: src(ms[0].file, ms[0].line), methods: ms.map((p) => ({ name: p.name, line: p.line })),
        });
    }
    if (seamShown.length)
        addEl({ id: SEAM_ID, type: 'component', parent: `${APP}.api`, provenance: 'extracted', name: 'live seam', technology: 'supabase-js', description: `${C.SRC}/${C.SEAM}/: the one supabase-js client, invokeEdge(), and helpers shared by the live adapters.`, source: src(seamShown[0].file, seamShown[0].line), methods: seamShown.map((s) => ({ name: s.name, line: s.line })) });
    const extEl = (key: string): string => {
        const x = EXTERNALS[key];
        return addEl({ id: x.id, type: 'external-system', parent: null, provenance: 'declared', name: x.name, technology: x.technology, source: cfgSrc(`REACT_CLIENT.EXTERNALS.${key}`) });
    };

    // ---------- edges ----------
    const authCalls = new Map<Edge, Set<string>>(); // edge → calls
    const fromOf = (x: CandPort | CandSeam) => (ports.has(x.key) ? { from: domComp((x as CandPort).domain), fromMethod: x.name } : { from: SEAM_ID, fromMethod: x.name });
    for (const x of [...ports.values(), ...seam.values()].filter((y) => effective.has(y.key))) {
        const at = fromOf(x);
        for (const e of x.effects) {
            const site = src(e.site.file, e.site.line);
            if (e.kind === 'table') {
                const to = tableId(e.schema, e.table);
                if (!to) {
                    unresolved.push({ kind: 'unknown-table', repo: REPO_ID, file: e.site.file, line: e.site.line, element: at.from, method: at.fromMethod, expr: `.from('${e.table}').${e.op}() — not in the ${e.schema} schema of the snapshot` });
                    continue;
                }
                const channel = e.op === 'select' ? 'read' : 'write';
                const api = dataApi.get(`${to}|${channel}`);
                const edge = addEdge({ ...at, to, channel, ops: [e.op], via: VIA.REST, access: api?.access, site, source: site });
                if (!api && !edge.label) {
                    edge.label = 'no Data API grant or policy for anon / authenticated on dev';
                    unresolved.push({ kind: 'data-api-denied', repo: REPO_ID, file: e.site.file, line: e.site.line, element: at.from, method: at.fromMethod, expr: `${channel} ${e.table}: the Data API serves it to neither anon nor authenticated on dev (grants ∧ RLS)` });
                }
            } else if (e.kind === 'rpc') {
                const to = rpcId(e.fn);
                if (to) addEdge({ ...at, to, channel: 'rest', label: `rpc ${e.fn}`, via: VIA.REST, site, source: site });
                else unresolved.push({ kind: 'unknown-rpc', repo: REPO_ID, file: e.site.file, line: e.site.line, element: at.from, method: at.fromMethod, expr: `.rpc('${e.fn}') — no such RPC in the snapshot` });
            } else if (e.kind === 'edge') {
                const t = edgeTarget(e);
                if (t.ep) addEdge({ ...at, to: t.ep.id, channel: 'rest', label: `${t.ep.http!.method} ${t.ep.http!.path}`, via: VIA.GW, site, source: site });
                else unresolved.push({ kind: t.none!, repo: REPO_ID, file: e.site.file, line: e.site.line, element: at.from, method: at.fromMethod, expr: t.candidates ? `${e.expr} — one of ${t.candidates.join(' | ')}, not bound here` : `${t.path ?? e.expr}` });
            } else if (e.kind === 'auth' && ids.auth) {
                const edge = addEdge({ ...at, to: ids.auth, channel: 'rest', via: VIA.GW, site, source: site });
                (authCalls.get(edge) ?? authCalls.set(edge, new Set()).get(edge)!).add(e.call);
            } else if (e.kind === 'fetch') {
                const host = e.url && /^https?:\/\/([^/:?#$]+)/.exec(e.url)?.[1];
                const key = host && hostExt(host);
                if (key) addEdge({ ...at, to: extEl(key), channel: 'https', ops: [host as string], site, source: site });
                else unresolved.push({ kind: host ? 'unknown-host' : 'dynamic-url', repo: REPO_ID, file: e.site.file, line: e.site.line, element: at.from, method: at.fromMethod, expr: e.url ?? e.expr });
            } else if (e.kind === 'unresolved') unresolved.push({ kind: e.code, repo: REPO_ID, file: e.site.file, line: e.site.line, element: at.from, method: at.fromMethod, expr: e.expr });
        }
        for (const c of x.calls) {
            const k = c.port ?? c.seam;
            if (!effective.has(k)) continue;
            // effective holds keys of ports and seam functions only
            const t = ports.get(k!) ?? seam.get(k!);
            const to = fromOf(t!);
            const site = src(c.site.file, c.site.line);
            addEdge({ ...at, to: to.from, toMethod: to.fromMethod, channel: 'call', site, source: site });
        }
    }
    for (const [edge, calls] of authCalls) edge.label = `/auth/v1: ${[...calls].sort().join(', ')}`;
    // screens → port methods
    let toQuiet = 0;
    for (const r of shownRoots) {
        const from = rootComp.get(r.file);
        for (const { port, site: s } of r.reach) {
            const p = ports.get(port);
            const site = src(s.file, s.line);
            if (shownPort(port)) addEdge({ from: from!, fromMethod: r.main.name, to: domComp(p!.domain), toMethod: p!.name, channel: 'call', site, source: site });
            else if (p?.stub) unresolved.push({ kind: 'pending-call', repo: REPO_ID, file: s.file, line: s.line, element: from, method: r.main.name, expr: `${port.replace('#', '.')}() — its live adapter is a stub: ${p.stub}` });
            else toQuiet++;
        }
    }
    // stub port methods, with what their domain owns (the owners file: planned, never edges)
    const ownsOf = (d: string): string[] => Object.entries(analysis.owners).filter(([, v]) => v === d).map(([k]) => k).sort();
    for (const p of ports.values()) {
        if (!p.stub) continue;
        unresolved.push({ kind: 'pending-live', repo: REPO_ID, file: p.file, line: p.line, element: domains.includes(p.domain) ? domComp(p.domain) : undefined, method: p.name, expr: `${p.domain}.${p.name}(): ${p.stub}`, planned: ownsOf(p.domain).length ? ownsOf(p.domain) : undefined });
    }
    // (`i.kind` is 'route' too; the outer object keeps the key order kind, repo, file, line, expr)
    for (const i of analysis.routeIssues) unresolved.push({ ...{ kind: 'route', repo: REPO_ID }, ...i });

    // ---------- out ----------
    // a module has no line of its own: it points where its first part is
    const byId = [...elements.values()].sort((a, b) => cmp(a.id, b.id));
    for (const el of byId) if (!el.source) el.source = byId.find((x) => x.source && x.id.startsWith(`${el.id}.`))?.source;
    const edgeList = finishEdges();
    unresolved.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || cmp(a.expr, b.expr));
    const doc: ArchMapSpecDocument = {
        schemaVersion: '1.2.0',
        id: config.DOCS.reactClient.id,
        title: config.DOCS.reactClient.title,
        requires: [`${config.DOCS.supabase.id}.json`, `${config.DOCS.edge.id}.json`],
        repos: commit ? { [REPO_ID]: { url: C.repo.url, commit, blob: `${C.repo.url}/blob/${commit}/{file}#L{line}` } } : {},
        elements: [...elements.values()],
        edges: edgeList,
    };
    const stubs = [...ports.values()].filter((p) => p.stub);
    return {
        doc, unresolved,
        stats: {
            routes: analysis.routes.length, screens: shownRoots.filter((r) => r.kind === 'screen').length, shell: shownRoots.filter((r) => r.kind === 'app').length,
            portMethods: ports.size, live: [...ports.keys()].filter((k) => effective.has(k)).length, stubs: stubs.length,
            stubDomains: [...new Set(stubs.map((p) => p.domain))].filter((d) => !domains.includes(d)).sort(), domains,
            quietCalls: toQuiet,
        },
    };
}
