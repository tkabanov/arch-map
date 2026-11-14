// `buildSupabaseSpec`, the Supabase platform around the database (config SUPABASE_SERVICES, after Supabase's
// architecture page): the services as apps, the gateway and the connections to Postgres, the Data API's access to
// each table under its grants and RLS policies, Auth, Realtime, Storage with its schema and its buckets.
import type { ConfigSource, Site } from '../../../types/spec.d.ts';
import type { EdgeDraft } from '../../../types/generator.ts';
import type { SnapPolicy } from '../../../types/stacks/supabase.ts';
import { addEdge, addEl, enabled, fromSnap, putRel, relId, schemaModule, seg, src, tomlAt, tomlVal, type DbCtx, type Rel } from './db-ctx.ts';

/** The element ids of the platform parts that are on (null when off or absent from config.toml). */
export interface Services {
    GATEWAY: string | null;
    REST: string | null;
    GRAPHQL: string | null;
    AUTH: string | null;
    STORAGE: string | null;
    REALTIME: string | null;
    META: string | null;
    STUDIO: string | null;
    POOLER: string | null;
}

/** `source` of a declared part of the platform: its entry in the project config (`CONFIG_SOURCE`). */
const declaredSrc = (c: DbCtx, key: string): ConfigSource => ({ config: `${c.config.CONFIG_SOURCE}#SUPABASE_SERVICES.${key}` });

/** Facets that config.toml gives some services. */
function serviceFacets(c: DbCtx): Record<string, Record<string, unknown>> {
    const { toml } = c;
    return {
        rest: { 'supabase.api': { schemas: tomlVal(c, 'api', 'schemas'), extraSearchPath: tomlVal(c, 'api', 'extra_search_path'), maxRows: tomlVal(c, 'api', 'max_rows') } },
        auth: {
            'supabase.auth': {
                siteUrl: tomlVal(c, 'auth', 'site_url'), jwtExpiry: tomlVal(c, 'auth', 'jwt_expiry'), signup: tomlVal(c, 'auth', 'enable_signup'),
                anonymousSignIns: tomlVal(c, 'auth', 'enable_anonymous_sign_ins'), emailSignup: tomlVal(c, 'auth.email', 'enable_signup'),
                providers: [...toml.keys()].filter((x) => /^auth\.(external|third_party)\.[^.]+$/.test(x) && tomlVal(c, x, 'enabled') === true).map((x) => x.split('.').pop()),
            },
        },
        storage: { 'supabase.storage': { fileSizeLimit: tomlVal(c, 'storage', 'file_size_limit') } },
    };
}

/** a part of the platform: on when its config.toml section says so (the line is the source), else declared */
function addService(c: DbCtx, key: string, facets: Record<string, Record<string, unknown>>): string | null {
    const S = c.config.SUPABASE_SERVICES;
    const apiSchemas = (tomlVal(c, 'api', 'schemas') ?? []) as string[];
    const x = S[key];
    if (c.toml.size === 0) return null;
    if (x.toml && !enabled(c, x.toml)) return null;
    if (x.needsSchema && !apiSchemas.includes(x.needsSchema)) return null;
    const source: Site | ConfigSource | undefined = x.toml ? tomlAt(c, x.toml) : declaredSrc(c, key);
    return addEl(c, {
        id: x.id, type: 'app', parent: null, tier: x.tier ?? 'service', provenance: x.toml ? 'extracted' : 'declared', name: x.name, technology: x.technology,
        description: x.description, source, facets: { ...(facets[key] ?? {}), 'supabase.platform': { part: key, ...(x.path ? { path: x.path } : {}), docs: c.config.SUPABASE_ARCH } },
    });
}

export function addServices(c: DbCtx): Services {
    const facets = serviceFacets(c);
    return {
        GATEWAY: addService(c, 'gateway', facets),
        REST: addService(c, 'rest', facets),
        GRAPHQL: addService(c, 'graphql', facets),
        AUTH: addService(c, 'auth', facets),
        STORAGE: addService(c, 'storage', facets),
        REALTIME: addService(c, 'realtime', facets),
        META: addService(c, 'meta', facets),
        STUDIO: addService(c, 'studio', facets),
        POOLER: addService(c, 'pooler', facets),
    };
}

const platformEdge = (c: DbCtx, e: EdgeDraft, key: string) => addEdge(c, { ...e, ...(e.source ? {} : { provenance: 'declared', source: declaredSrc(c, key) }) });

/** the gateway in front of the services (Functions: in the Edge Functions document), and every part's connection to Postgres */
export function addPlatformEdges(c: DbCtx, s: Services): void {
    const S = c.config.SUPABASE_SERVICES;
    const { GATEWAY, REST, GRAPHQL, AUTH, STORAGE, REALTIME, META, STUDIO, POOLER } = s;
    if (GATEWAY) {
        for (const [key, to] of [['rest', REST], ['graphql', GRAPHQL], ['auth', AUTH], ['storage', STORAGE], ['realtime', REALTIME], ['meta', META]] as const) {
            if (to) platformEdge(c, { from: GATEWAY, to, channel: 'rest', label: S[key].path, source: S[key].toml ? tomlAt(c, S[key].toml) : undefined }, key);
        }
    }
    // every part talks to the one Postgres; what it touches is known for some (below), the rest go to the datastore
    if (STUDIO && META) platformEdge(c, { from: STUDIO, to: META, channel: 'rest', label: 'manages the database', source: tomlAt(c, 'studio') }, 'studio');
    if (META) for (const ch of ['read', 'write']) platformEdge(c, { from: META, to: c.DB, channel: ch, ops: ch === 'read' ? ['catalog'] : ['DDL', 'roles'] }, 'meta');
    if (GRAPHQL) for (const ch of ['read', 'write']) platformEdge(c, { from: GRAPHQL, to: c.DB, channel: ch, label: 'graphql.resolve() inside Postgres, under RLS', source: tomlAt(c, 'api', 'schemas') }, 'graphql');
    if (POOLER) for (const ch of ['read', 'write']) platformEdge(c, { from: POOLER, to: c.DB, channel: ch, label: 'pooled connections' }, 'pooler');
}

/** Storage keeps its metadata in Postgres */
export function addStorageSchema(c: DbCtx, s: Services): void {
    const { STORAGE } = s;
    if (!STORAGE) return;
    const parent = schemaModule(c, 'storage', c.DB, { context: true, provenance: 'declared', source: declaredSrc(c, 'storage'), description: 'Supabase Storage\'s schema: metadata of buckets and objects.' });
    const pol0 = c.snap.policies.find((p) => p.schema === 'storage');
    for (const t of ['buckets', 'objects']) {
        const id = addEl(c, { id: relId(c, 'storage', t), type: 'table', parent, provenance: 'declared', name: t, context: true, description: t === 'objects' ? 'One row per stored file; its RLS policies decide access to files.' : 'One row per bucket.', source: declaredSrc(c, 'storage') });
        putRel(c, { id, schema: 'storage', name: t, kind: 'table' });
        for (const ch of ['read', 'write']) platformEdge(c, { from: STORAGE, to: id, channel: ch, ops: ch === 'read' ? ['select'] : ['insert', 'update', 'delete'], label: 'file metadata', ...(t === 'objects' && pol0 ? { source: fromSnap(c, 'policies', `storage.objects.${pol0.name}`) } : {}) }, 'storage');
    }
}

const VIEW_LABEL = 'view: grants only';
/** the snapshot has no `security_invoker` of views: say what that leaves open, invent no policies */
const VIEW_GUARD = 'view, no RLS of its own: by grants only; security_invoker not in the snapshot (if off, the view runs as its owner and bypasses RLS of the tables it reads)';

/** Which commands anon / authenticated reach on a table or view through the Data API, and under which policies. */
function dataApiAccess(c: DbCtx, r: Rel): { cmd: string; channel: string; level: 'public' | 'authenticated'; policies: string[] }[] {
    const t = r.table ?? { ...r.view!, rls: false }; // a view has no RLS of its own: its grants decide
    const out: ReturnType<typeof dataApiAccess> = [];
    for (const [cmd, channel] of [['select', 'read'], ['insert', 'write'], ['update', 'write'], ['delete', 'write']] as const) {
        const roles = ['anon', 'authenticated'].filter((role) => t.grants.some((g) => g.role === role && g.privilege.toLowerCase() === cmd));
        if (!roles.length) continue;
        if (!t.rls) {
            out.push({ cmd, channel, level: roles.includes('anon') ? 'public' : 'authenticated', policies: [] });
            continue;
        }
        const pols = (c.policiesOf.get(`${t.schema}.${t.name}`) ?? []).filter((p) => p.command === cmd || p.command === 'all');
        const reach = (p: SnapPolicy): boolean => p.roles.some((x) => x === 'public' || roles.includes(x));
        const permissive = pols.filter((p) => p.permissive && reach(p));
        if (!permissive.length) continue; // RLS on and no policy lets anyone in
        const restrictive = pols.filter((p) => !p.permissive && reach(p));
        const anon = permissive.some((p) => p.roles.includes('anon') || p.roles.includes('public')) && roles.includes('anon');
        out.push({ cmd, channel, level: anon ? 'public' : 'authenticated', policies: [...permissive, ...restrictive].map((p) => p.name) });
    }
    return out;
}

/** PostgREST → each table and view of the API schemas, one edge per channel with the policies that decide access */
export function addDataApiEdges(c: DbCtx, s: Services): void {
    const { REST } = s;
    if (!REST) return;
    const apiSchemas = new Set(((tomlVal(c, 'api', 'schemas') ?? c.config.API_SCHEMAS) as string[]).filter((x) => c.shown.has(x)));
    for (const r of c.rels.values()) {
        if (!apiSchemas.has(r.schema)) continue;
        const acc = new Map<string, { ops: string[]; level: string; policies: Set<string> }>(); // channel → { ops, level, policies }
        for (const a of dataApiAccess(c, r)) {
            const cur = acc.get(a.channel) ?? { ops: [], level: 'authenticated', policies: new Set<string>() };
            cur.ops.push(a.cmd);
            if (a.level === 'public') cur.level = 'public';
            for (const p of a.policies) cur.policies.add(p);
            acc.set(a.channel, cur);
        }
        for (const [channel, a] of acc) {
            const policies = [...a.policies].sort();
            addEdge(c, {
                from: REST, to: r.id, channel, ops: a.ops, label: r.view ? VIEW_LABEL : policies.length ? undefined : 'no RLS',
                access: { level: a.level, ...(policies.length ? { policies } : {}), ...(r.view ? { guards: [VIEW_GUARD] } : {}) },
                source: r.view ? src(c, c.index.view(r.schema, r.name), 'views', `${r.schema}.${r.name}`) : src(c, c.index.table(r.schema, r.name), 'tables', `${r.schema}.${r.name}`),
            });
        }
    }
}

/** PostgREST → each RPC endpoint of the functions: the Data API is the only way in from outside, with the endpoint's access */
export function addRpcEdges(c: DbCtx, s: Services): void {
    const { REST } = s;
    if (!REST) return;
    for (const e of c.elements.values()) {
        if (e.type !== 'endpoint' || !e.http?.path.startsWith('/rest/v1/rpc/')) continue;
        addEdge(c, { from: REST, to: e.id, channel: 'rest', label: `rpc ${e.http.path.split('/').pop()}`, ...(e.access ? { access: e.access } : {}), ...(e.source ? { source: e.source } : {}) });
    }
}

export function addAuthRealtimeEdges(c: DbCtx, s: Services): void {
    const { AUTH, REALTIME } = s;
    if (AUTH && c.authUsers) addEdge(c, { from: AUTH, to: relId(c, 'auth', 'users'), channel: 'write', ops: ['insert', 'update', 'delete'], label: 'sign-up, sign-in, deletion', source: tomlAt(c, 'auth') });
    if (REALTIME) {
        for (const k of c.realtime) {
            const r = c.rels.get(k);
            if (!r) continue;
            const pols = (c.policiesOf.get(k) ?? []).filter((p) => p.command === 'select' || p.command === 'all').map((p) => p.name).sort();
            addEdge(c, { from: REALTIME, to: r.id, channel: 'read', ops: ['select'], label: 'changes (publication supabase_realtime)', access: { level: 'authenticated', ...(pols.length ? { policies: pols } : {}) }, source: fromSnap(c, 'realtime', k) });
        }
    }
}

/** buckets: a datastore of files beside Postgres */
export function addBuckets(c: DbCtx, s: Services): void {
    const { snap } = c;
    const { STORAGE } = s;
    if (!(STORAGE && snap.buckets.length)) return;
    const FILES = addEl(c, { id: `${c.config.ID}.files`, type: 'datastore', parent: null, provenance: 'extracted', name: 'File storage', technology: 'S3 (Supabase Storage)', description: 'Buckets of Supabase Storage.', source: tomlAt(c, 'storage') });
    const storagePols = snap.policies.filter((p) => p.schema === 'storage' && p.table === 'objects');
    for (const b of snap.buckets) {
        const id = addEl(c, { id: `${FILES}.${seg(b.id)}`, type: 'table', parent: FILES, provenance: 'extracted', name: b.id, technology: 'bucket', source: fromSnap(c, 'buckets', b.id), facets: { 'storage.bucket': { public: b.public, fileSizeLimit: b.fileSizeLimit ?? undefined, allowedMimeTypes: b.allowedMimeTypes ?? undefined } } });
        const mine = storagePols.filter((p) => `${p.using ?? ''} ${p.withCheck ?? ''}`.includes(`'${b.id}'`));
        const names = (cmds: string[]): string[] => mine.filter((p) => cmds.includes(p.command) || p.command === 'all').map((p) => p.name).sort();
        const readPols = names(['select']);
        addEdge(c, { from: STORAGE, to: id, channel: 'read', ops: ['select'], label: b.public ? 'public bucket: anyone with the URL' : undefined, access: b.public ? { level: 'public' } : { level: 'authenticated', ...(readPols.length ? { policies: readPols } : {}) }, source: fromSnap(c, 'buckets', b.id) });
        const writePols = names(['insert', 'update', 'delete']);
        addEdge(c, { from: STORAGE, to: id, channel: 'write', ops: ['insert', 'update', 'delete'].filter((cmd) => mine.some((p) => p.command === cmd || p.command === 'all')), access: writePols.length ? { level: 'authenticated', policies: writePols } : { level: 'restricted', roles: ['service_role'] }, source: fromSnap(c, 'buckets', b.id) });
    }
}
