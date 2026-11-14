// `buildEdgeSpec`, the elements: which units matter (they reach something, or are a handler), the domain cluster of
// each function, the app, modules, components (one per file) and endpoints with their access and contracts.
import { cmp, seg } from '../../lib/spec-build.ts';
import type { Access } from '../../../types/spec.d.ts';
import type { DomainAssignment, EdgeRoute, EdgeUnit } from '../../../types/stacks/supabase.ts';
import {
    FN_DIR, bucketId, fullOf, moduleOf, pascal, rpcId, src, tableId, top, urlTarget,
    type EdgeCtx, type EdgeModule, type OpenApiBody,
} from './edge-ctx.ts';

/** The options of an access check (`authenticate(req, { … })`, a route's `authentication`), folded from the code. */
interface AuthOptions {
    requireServiceRole?: unknown;
    requireRBAC?: unknown;
    allowedRoles?: unknown;
    bypassWithServiceRole?: unknown;
    bypassWithAnonRole?: unknown;
    disableAuthentication?: unknown;
}

// ---------- relevance: handlers, and what reaches a table / RPC / bucket / outside / another function ----------

/** a unit has an effect of its own when it touches a known table, RPC or bucket, a known port, or a URL that is something */
function hasEffect(c: EdgeCtx, u: EdgeUnit): boolean {
    let has = false;
    for (const t of u.tables.values()) if (tableId(c, t.schema, t.table)) has = true;
    for (const r of u.rpcs.values()) if (rpcId(c, r.schema, r.fn)) has = true;
    for (const b of u.buckets.values()) if (bucketId(c, b.bucket)) has = true;
    if (u.ports.size) has = true;
    for (const h of u.http) if (!urlTarget(c, h.url, h.method).none) has = true;
    return has;
}

export function selectRelevant(c: EdgeCtx): void {
    const { units, handlers } = c;
    const effects = new Map<EdgeUnit, boolean>(); // unit → has an effect of its own
    for (const u of units) effects.set(u, hasEffect(c, u));
    const relevant = new Set([...units.filter((u) => effects.get(u))]);
    for (let changed = true; changed; ) {
        changed = false;
        for (const u of units) {
            if (relevant.has(u)) continue;
            for (const { target } of u.calls.values())
                if (relevant.has(target)) {
                    relevant.add(u);
                    changed = true;
                }
        }
    }
    c.relevant = relevant;
    c.shown = new Set([...relevant, ...handlers]);
}

// domains: an Edge Function joins the cluster its folder name says (`publish-job` → job), else the one whose
// tables it touches most; shared code (helpers/, common/) stays at the top; clusters under minEdgeGroup → other
export function assignEdgeDomains(c: EdgeCtx): void {
    const { domains, shown, units, ids, config } = c;
    if (!domains) return;
    const folders = [...new Set([...shown].map((u) => top(u.file)))].filter((f) => !config.EDGE.SHARED.includes(f));
    const tableName = new Map([...ids.tables].map(([k, id]) => [id, k.split('.').pop()]));
    const assigned = new Map<string, DomainAssignment>();
    for (const f of folders) {
        const byName = domains.nameDomain(f);
        if (byName) {
            assigned.set(f, { domain: byName, rule: 'name' });
            continue;
        }
        const uses: { table: string; weight: number }[] = [];
        for (const u of units) if (top(u.file) === f) for (const t of u.tables.values()) uses.push({ table: t.table, weight: t.op === 'select' ? 1 : 2 });
        const byData = domains.dataDomain(uses.filter((x) => tableName.size === 0 || [...tableName.values()].includes(x.table)));
        assigned.set(f, byData ? { domain: byData, rule: 'data' } : { domain: 'other', rule: 'none' });
    }
    domains.fold(assigned, config.DOMAINS.minEdgeGroup);
    for (const [f, a] of assigned) c.fnDomain.set(f, a.domain);
}

// ---------- elements ----------

export function addEdgeApp(c: EdgeCtx): void {
    c.b.addEl({
        id: c.APP, type: 'app', parent: null, tier: 'service', provenance: 'extracted', name: 'Edge Functions', technology: 'Deno, Supabase Edge Functions',
        description: 'HTTP functions behind /functions/v1, one per folder of supabase/functions; shared code in helpers/.',
        source: c.tomlAt('edge_runtime') ?? src(c, c.routes[0]?.file ?? '', 1),
    });
    c.filesShown = [...new Set([...c.shown].map((u) => u.file))].sort();
}

/** the modules the shown files live in, with the domain cluster above a function's folder */
function collectModules(c: EdgeCtx): Map<string, EdgeModule> {
    const modules = new Map<string, EdgeModule>();
    for (const file of c.filesShown) {
        const mod = moduleOf(c, file);
        if (!modules.has(mod.id)) modules.set(mod.id, mod);
        if (mod.parent !== c.APP && !modules.has(mod.parent))
            modules.set(mod.parent, mod.domain ? { id: mod.parent, name: mod.domain, parent: c.APP, folder: null, domain: true } : { id: mod.parent, name: top(file), parent: c.APP, folder: top(file) });
    }
    return modules;
}

export function addModules(c: EdgeCtx): Map<string, EdgeModule> {
    const { routes, routeFns, filesShown } = c;
    const modules = collectModules(c);
    for (const mod of [...modules.values()].sort((a, b) => cmp(a.id, b.id))) {
        if (mod.domain === true) {
            c.b.addEl({
                id: mod.id, type: 'module', parent: c.APP, provenance: 'extracted', name: mod.name,
                description: mod.name === 'other' ? 'Edge Functions of small domains.' : `Edge Functions about «${mod.name}»: by their name, else by the tables they use most.`,
                derivedFrom: { rule: 'prefix', value: mod.name }, confidence: 'medium',
            });
            continue;
        }
        const isFn = routeFns.has(mod.name);
        const firstRoute = routes.find((r) => r.fn === mod.name);
        const fc = c.fnConfig(mod.name);
        c.b.addEl({
            id: mod.id, type: 'module', parent: mod.parent, provenance: 'extracted', name: mod.name,
            description: isFn ? `Edge Function «${mod.name}» (${firstRoute?.basePath || '/'})` : `Shared code: ${mod.folder}/`,
            source: firstRoute ? src(c, firstRoute.file, firstRoute.line) : src(c, `${mod.folder}/${filesShown.find((f) => f.startsWith(`${mod.folder}/`))?.slice(mod.folder!.length + 1) ?? ''}`, 1),
            facets: isFn ? { 'deno.edge': { function: mod.name, basePath: firstRoute?.basePath, verifyJwt: fc?.verify_jwt } } : undefined,
        });
    }
    return modules;
}

/** components: a file; its id from the file name, made unique inside the module with its folder */
export function addComponents(c: EdgeCtx, modules: Map<string, EdgeModule>): void {
    const { shown, compOfFile } = c;
    const taken = new Map<string, string>();
    for (const file of c.filesShown) {
        const mod = moduleOf(c, file);
        const base = seg(file.split('/').pop()!.replace(/\.ts$/, ''));
        let id = `${mod.id}.${base}`;
        if (taken.has(id) || c.b.elements.has(id) || modules.has(id)) id = `${mod.id}.${seg(file.split('/').slice(mod.folder.split('/').length, -1).join('_'))}_${base}`;
        taken.set(id, file);
        compOfFile.set(file, id);
        const fileUnits = [...shown].filter((u) => u.file === file).sort((a, b) => a.line - b.line);
        c.b.addEl({
            id, type: 'component', parent: mod.id, provenance: 'extracted', name: file.split('/').pop(), source: src(c, file, fileUnits[0]?.line ?? 1),
            methods: fileUnits.map((u) => ({ name: u.name, line: u.line })),
        });
    }
}

// ---------- endpoints and their contracts ----------

const opOf = (c: EdgeCtx, r: EdgeRoute) => {
    const path = (fullOf(r).replace(/\/$/, '') || '/').replace(/:(\w+)/g, '{$1}');
    return c.openapi?.paths?.[path]?.[r.method.toLowerCase()];
};

function hoist(c: EdgeCtx, schema: unknown, name: string): string | undefined {
    const { contractSchemas } = c;
    if (!schema || !name) return undefined;
    const text = JSON.stringify(schema);
    let n = name;
    for (let i = 2; contractSchemas.has(n) && JSON.stringify(contractSchemas.get(n)) !== text; i++) n = `${name}_${i}`;
    contractSchemas.set(n, schema);
    return `#/components/schemas/${n}`;
}

/** the check the handler runs itself (its own body or what it calls, two levels down), first found */
function handlerCheck(u: EdgeUnit): EdgeUnit | null {
    const seen = new Set<EdgeUnit>();
    let level = [u];
    for (let d = 0; d < 3 && level.length; d++) {
        for (const x of level) if (x.auth !== undefined || x.guards.size) return x;
        const next: EdgeUnit[] = [];
        for (const x of level)
            for (const { target } of x.calls.values())
                if (!seen.has(target)) {
                    seen.add(target);
                    next.push(target);
                }
        level = next;
    }
    return null;
}

/** what a request needs: the handler's own check wins over the route options (it is what runs) */
function accessOf(r: EdgeRoute): Access {
    const own = r.handler && handlerCheck(r.handler);
    const a = (own?.auth ?? r.authentication ?? {}) as AuthOptions;
    const guards = [...(own?.guards ?? [])].sort();
    const sec = ((r.security ?? []) as (Record<string, unknown> | null)[]).flatMap((s) => Object.keys(s ?? {}));
    if (sec.includes('apiKeyAuth') && !guards.includes('partner API key')) guards.push('partner API key');
    const g = guards.length ? { guards } : {};
    if (a.requireServiceRole) return { level: 'restricted', roles: ['service_role'], ...g };
    // bypassWithServiceRole: the service role passes too (cron jobs, other functions)
    if (a.requireRBAC && Array.isArray(a.allowedRoles) && a.allowedRoles.length) return { level: 'restricted', roles: [...a.allowedRoles.filter((x) => typeof x === 'string'), ...(a.bypassWithServiceRole ? ['service_role'] : [])].sort(), ...g };
    if (own?.auth !== undefined) return a.bypassWithAnonRole ? { level: 'public', guards: ['anon key', ...guards] } : { level: 'authenticated', ...g };
    if (guards.length) return { level: guards.includes('partner API key') ? 'restricted' : 'public', ...g };
    if (r.disableAuthentication === true || r.authRequired === false || a.disableAuthentication) return { level: 'public' };
    if (a.bypassWithAnonRole) return { level: 'public', guards: ['anon key'] };
    return { level: 'authenticated' };
}

export function addEndpoints(c: EdgeCtx): void {
    const { routes, compOfFile, openapi } = c;
    for (const r of routes) {
        if (!r.handler || !compOfFile.has(r.handler.file)) continue;
        const comp = compOfFile.get(r.handler.file)!;
        const full = fullOf(r).replace(/\/$/, '') || '/';
        const id = `${comp}.${r.method.toLowerCase()}_${seg(full)}`;
        const op = opOf(c, r);
        const json = (x: OpenApiBody) => x?.content?.['application/json']?.schema;
        const request = hoist(c, json(op?.requestBody), r.requestDto ? pascal(r.requestDto) : `${pascal(r.handler.name)}Request`);
        const okResp = op?.responses?.['200'] ?? op?.responses?.['201'];
        const response = hoist(c, json(okResp), r.responseDto ? pascal(r.responseDto) : `${pascal(r.handler.name)}Response`);
        if (!op && openapi) c.unresolved.push({ kind: 'no-openapi', repo: c.REPO_ID, file: `${FN_DIR}/${r.file}`, line: r.line, element: id, expr: `${r.method} ${full} is not in openapi/schema.ts` });
        c.b.addEl({
            id, type: 'endpoint', parent: comp, provenance: 'extracted', name: `${r.method} ${full}`, description: r.summary,
            handler: r.handler.name, http: { method: r.method, path: full.replace(/:(\w+)/g, '{$1}') }, access: accessOf(r),
            contract: request || response ? { doc: c.config.DOCS.edge.contract, ...(request ? { request } : {}), ...(response ? { response } : {}) } : undefined,
            source: src(c, r.file, r.line),
            facets: { 'deno.route': { authRequired: r.authRequired, disableAuthentication: r.disableAuthentication, authentication: r.authentication, security: r.security } },
        });
        c.endpointOf.set(r, id);
    }
}

