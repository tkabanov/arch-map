// The shared state of `buildSupabaseSpec` (db.ts) and the helpers its passes use: the elements and edges being
// accumulated, where a fact is taken from (a migration, the snapshot, config.toml), and the lookup of relations and
// functions named in SQL. Each pass (db-schema.ts, db-functions.ts, db-platform.ts) takes this context.
import { makeDomains } from './domains.ts';
import type { Edge, Element, Site } from '../../../types/spec.d.ts';
import type { EdgeDraft, ElementDraft, UnresolvedEntry } from '../../../types/generator.ts';
import type { DbHttpCall, DomainAssignment, Domains, Facts, FileLine, MigrationIndex, QName, SnapAt, SnapFunction, SnapPolicy, SnapTable, SnapView, Toml, SupabaseConfig, DbSnapshot } from '../../../types/stacks/supabase.ts';

/** A relation (table or view) on the map. */
export interface Rel {
    id: string;
    schema: string;
    name: string;
    kind: 'table' | 'view';
    table?: SnapTable;
    view?: SnapView;
}
/** A function of the snapshot by `schema.name`: its overloads and what each body does. */
export interface FnGroup {
    schema: string;
    name: string;
    overloads: SnapFunction[];
    facts: Facts[];
}
/** What gets counted instead of drawn. */
export interface Skipped {
    supabaseRelations: number;
    hiddenSchemaRelations: number;
    hiddenSchemaCalls: number;
    transitionTables: number;
}
/** `resolveRel`: the relation, or why there is none. */
interface ResolvedRel {
    rel?: Rel;
    skip?: keyof Skipped;
    missing?: boolean;
}
/** The inputs of `buildSupabaseSpec`. */
export interface DbInput {
    snap: DbSnapshot;
    config: SupabaseConfig;
    index: MigrationIndex;
    toml: Toml;
    commit: string | null;
    snapAt: SnapAt;
    snapFile: string;
    snapHash: string;
}

export const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
/** Id segment from a database name (already snake case; keep a leading underscore of `_internal`). */
export const seg = (s: unknown): string => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/__+/g, '_').replace(/_+$/, '') || 'x';
export const methodName = (s: unknown): string => String(s).replace(/[^A-Za-z0-9_$]+/g, '_');
const SUPABASE_SCHEMAS = new Set(['auth', 'storage', 'realtime', 'vault', 'extensions', 'cron', 'net', 'graphql', 'graphql_public', 'pgbouncer', 'supabase_functions', 'supabase_migrations', 'pg_catalog', 'information_schema', 'pgsodium', 'gis', 'repack']);

/** Reserved functions module segment; a matching table domain takes `_d`, a schema takes an unused `_s` suffix. */
export const FUNCTIONS_SEG = 'functions';

/** What `buildSupabaseSpec` accumulates; every pass reads the inputs and adds to the maps. */
export interface DbCtx extends DbInput {
    /** the database (`<ID>.db`) and its functions module (`<ID>.db.functions`): roots of their ids */
    DB: string;
    PG: string;
    domains: Domains;
    /** a domain's segment under an app: never the same as a schema module beside it */
    schemaSegs: Set<string>;
    /** Schema names to their segments under the datastore, excluding the reserved functions module. */
    schemaIds: Map<string, string>;
    shown: Set<string>;
    REPO_ID: string;
    elements: Map<string, Element>;
    edges: Map<string, Edge>;
    unresolved: UnresolvedEntry[];
    skipped: Skipped;
    /** schema.name → { id, schema, name, kind } for every relation on the map */
    rels: Map<string, Rel>;
    /** name → [rel] across shown schemas */
    byName: Map<string, Rel[]>;
    /** schema.table → policies */
    policiesOf: Map<string, SnapPolicy[]>;
    realtime: Set<string>;
    /** Supabase's own tables the system's code touches: auth.users (sign-up triggers, foreign keys) */
    authUsers: boolean;
    /** transition tables of statement triggers (`REFERENCING NEW TABLE AS new_rows`) are not relations of the schema */
    transition: Set<string>;
    /** schema.name → { schema, name, overloads: [fn], facts } */
    fnsByKey: Map<string, FnGroup>;
    assigned: Map<FnGroup, DomainAssignment>;
    /** g → main table, for the functions of large domain groups */
    subgroup: Map<FnGroup, string>;
    /** g → component id */
    fnId: Map<FnGroup, string>;
    httpCalls: DbHttpCall[];
    /** the label of the cron job being read (its HTTP calls are `schedule` edges) */
    schedLabel: string | undefined;
}

export function makeDbCtx(input: DbInput): DbCtx {
    const { snap, config } = input;
    const { SHOWN_SCHEMAS, REPO } = config;
    // domains: public tables and views cluster by the first word of their name; functions by name or use
    const domains = makeDomains(config.DOMAINS, [...snap.tables, ...snap.views].filter((t) => t.schema === 'public').map((t) => t.name));
    const schemaIds = new Map([...SHOWN_SCHEMAS, 'auth', 'storage'].map((s) => [s, seg(s)]));
    const occupied = new Set([...schemaIds.values(), ...[...domains.vocab].map(seg), FUNCTIONS_SEG]);
    for (const [schema, part] of schemaIds) {
        if (part !== FUNCTIONS_SEG) continue;
        let candidate = `${part}_s`;
        while (occupied.has(candidate)) candidate += '_s';
        schemaIds.set(schema, candidate);
        occupied.add(candidate);
    }
    const policiesOf = new Map<string, SnapPolicy[]>();
    for (const p of snap.policies) {
        const k = `${p.schema}.${p.table}`;
        if (!policiesOf.has(k)) policiesOf.set(k, []);
        policiesOf.get(k)!.push(p);
    }
    return {
        ...input,
        domains,
        schemaSegs: new Set([...schemaIds.values(), FUNCTIONS_SEG]),
        schemaIds,
        shown: new Set(SHOWN_SCHEMAS),
        REPO_ID: REPO.id,
        DB: `${config.ID}.db`,
        PG: `${config.ID}.db.${FUNCTIONS_SEG}`,
        elements: new Map(),
        edges: new Map(),
        unresolved: [],
        skipped: { supabaseRelations: 0, hiddenSchemaRelations: 0, hiddenSchemaCalls: 0, transitionTables: 0 },
        rels: new Map(),
        byName: new Map(),
        policiesOf,
        realtime: new Set(snap.realtime.map((r) => `${r.schema}.${r.name ?? r.table}`)),
        authUsers: snap.tables.some((t) => t.fks.some((f) => f.refSchema === 'auth' && f.refTable === 'users')) || snap.triggers.some((t) => t.schema === 'auth' && t.table === 'users'),
        transition: new Set(snap.triggers.flatMap((t) => [...t.definition.matchAll(/\b(?:OLD|NEW) TABLE AS (\w+)/gi)].map((m) => m[1]))),
        fnsByKey: new Map(),
        assigned: new Map(),
        subgroup: new Map(),
        fnId: new Map(),
        httpCalls: [],
        schedLabel: undefined,
    };
}

// ---------- where a fact is taken from ----------

export function fromSnap(c: DbCtx, section: string, key: string | undefined): Site | undefined {
    const line = key && c.snapAt(section, key);
    return line ? { repo: 'snapshot', file: c.snapFile, line } : undefined;
}
/** a migration of the repo when the object is written there, else the snapshot's line */
export function src(c: DbCtx, at: FileLine | undefined, section: string, key: string): Site | undefined {
    return at && c.commit ? { repo: c.REPO_ID, file: at.file, line: at.line } : fromSnap(c, section, key);
}
export function tomlAt(c: DbCtx, section: string, key?: string): Site | undefined {
    const sec = c.toml.get(section);
    const line = key ? sec?.values.get(key)?.line : sec?.line;
    return line && c.commit ? { repo: c.REPO_ID, file: 'supabase/config.toml', line } : undefined;
}
export const tomlVal = (c: DbCtx, section: string, key: string): unknown => c.toml.get(section)?.values.get(key)?.value;
export const enabled = (c: DbCtx, section: string): boolean => c.toml.has(section) && tomlVal(c, section, 'enabled') !== false;

// ---------- elements and edges ----------

export function addEl(c: DbCtx, el: ElementDraft): string {
    if (c.elements.has(el.id)) {
        const was = c.elements.get(el.id)!;
        if (was.type !== el.type || was.name !== el.name) throw new Error(`id ${el.id} is taken: ${was.type} «${was.name}» vs ${el.type} «${el.name}»`);
        return el.id;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el)) if (k === 'parent' || (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))) out[k] = v;
    // a draft with the schema's fields: the document is validated before it is written (writeSpec)
    c.elements.set(el.id, out as unknown as Element);
    return el.id;
}

// `ops` is an array until the end, where the empty ones are dropped
export function addEdge(c: DbCtx, e: EdgeDraft): Edge {
    const id = `${e.from}${e.fromMethod ? `#${e.fromMethod}` : ''}>${e.to}${e.toMethod ? `#${e.toMethod}` : ''}:${e.channel}`;
    const acc = c.edges.get(id);
    if (acc) {
        for (const op of e.ops ?? []) if (!acc.ops!.includes(op)) acc.ops!.push(op);
        return acc;
    }
    const draft: Record<string, unknown> = { id, provenance: 'extracted' };
    for (const [k, v] of Object.entries(e)) if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) draft[k] = v;
    const out = draft as unknown as Edge; // validated with the document (writeSpec)
    out.ops = [...(e.ops ?? [])];
    c.edges.set(id, out);
    return out;
}

export function schemaModule(c: DbCtx, schema: string, parent = c.DB, extra: Record<string, unknown> = {}): string {
    const part = parent === c.DB ? c.schemaIds.get(schema) ?? seg(schema) : seg(schema);
    return addEl(c, { id: `${parent}.${part}`, type: 'module', parent, provenance: 'extracted', name: schema, derivedFrom: { rule: 'schema', value: schema }, confidence: 'high', ...extra });
}
export const domSeg = (c: DbCtx, d: string): string => `${seg(d)}${c.schemaSegs.has(seg(d)) ? '_d' : ''}`;
export const relId = (c: DbCtx, schema: string, name: string): string => (schema === 'public' ? `${c.DB}.${domSeg(c, c.domains.tableDomain(name))}.${seg(name)}` : `${c.DB}.${c.schemaIds.get(schema) ?? seg(schema)}.${seg(name)}`);

export function putRel(c: DbCtx, r: Rel): void {
    c.rels.set(`${r.schema}.${r.name}`, r);
    if (!c.byName.has(r.name)) c.byName.set(r.name, []);
    c.byName.get(r.name)!.push(r);
}

// ---------- names in SQL ----------

/** A relation named in SQL (schema may be null) from code that lives in `ctxSchema`. */
export function resolveRel(c: DbCtx, q: QName, ctxSchema: string): ResolvedRel {
    if (!q.schema && c.transition.has(q.name)) return { skip: 'transitionTables' };
    if (q.schema) {
        const r = c.rels.get(`${q.schema}.${q.name}`);
        if (r) return { rel: r };
        if (SUPABASE_SCHEMAS.has(q.schema)) return { skip: 'supabaseRelations' };
        if (!c.shown.has(q.schema)) return { skip: 'hiddenSchemaRelations' };
        return { missing: true };
    }
    for (const s of [ctxSchema, 'public']) {
        const r = c.rels.get(`${s}.${q.name}`);
        if (r) return { rel: r };
    }
    const any = c.byName.get(q.name) ?? [];
    if (any.length === 1) return { rel: any[0] };
    return { missing: true };
}

export function resolveFn(c: DbCtx, q: QName, ctxSchema: string): FnGroup | null | undefined {
    if (q.schema) return c.fnsByKey.get(`${q.schema}.${q.name}`) ?? (c.shown.has(q.schema) ? null : undefined);
    return c.fnsByKey.get(`${ctxSchema}.${q.name}`) ?? c.fnsByKey.get(`public.${q.name}`);
}
