// Hand-written shapes of the Supabase stack: a Postgres snapshot and the Supabase platform around it, Edge Functions,
// and supabase-js clients (scripts/stacks/supabase/). `SupabaseConfig` is what the stack reads of
// a project config: <projects dir>/<p>/config.ts satisfies it. Types only.
import type * as TS from 'typescript';
import type { ElementId, Site, Tier } from '../spec.d.ts';
import type { UnresolvedEntry } from '../generator.ts';

// ---------- the stack config (what <projects dir>/<p>/config.ts exports) ----------

/** `EDGE`: how the Edge Functions (under supabase/functions) are read. */
export interface SupabaseEdgeConfig {
    /** folders that are not the system's code */
    EXCLUDE_DIRS: string[];
    /** typed ports of outside systems: a call of a port method is a call of that system */
    PORTS_DIR: string;
    /** helpers that POST to another Edge Function: argument index of the path, prefix of the path */
    KICK_HELPERS: Record<string, { pathArg: number; prefix: string }>;
    /** shared code whose subfolders become modules of their own */
    SPLIT_SHARED: string[];
    /** shared code that is not a domain: stays at the top */
    SHARED: string[];
    /** access checks a handler runs itself: the options helper, the other guards, guards of port methods */
    AUTH: { options: string; guards: Record<string, string>; portGuards: Record<string, string> };
}

/** `REACT_CLIENT`: a React + supabase-js client app (screens = route targets, API = ports with live adapters). */
export interface ReactClientConfig {
    repo: { id: string; url: string };
    /** the app element (`<ID>.cand`): its name, technology, description */
    APP: { name: string; technology: string; description: string };
    SRC: string;
    TSCONFIG: string;
    ROUTES: string;
    ROUTES_EXPORT: string;
    RESOURCES: string;
    SEAM: string;
    OWNERS_FILE: string;
    MOCK: RegExp;
    PORT_TYPES: RegExp;
    APP_ROOTS: RegExp;
    APP_SKIP: RegExp;
    /** wrappers of supabase.functions.invoke: name / options argument, default method */
    EDGE_HELPERS: Record<string, { nameArg: number; optionsArg: number; defaultMethod: string }>;
    /** a port method that only rejects with this error and message is a stub */
    STUB: { error: string; message: RegExp };
    /** outside systems only the client app calls, by host */
    EXTERNALS: Record<string, { id: ElementId; name: string; technology: string; hosts: RegExp[] }>;
}

/** One generated document: its id and title. */
export interface SupabaseDocConfig {
    id: string;
    title: string;
}

/** What the Supabase stack reads of a project config (`satisfies` it: `Satisfies<SupabaseConfig, typeof import('./config.ts')>`). */
export interface SupabaseConfig {
    /** repo-relative path of the config file: `source.config` of declared elements is `${CONFIG_SOURCE}#<export>` */
    CONFIG_SOURCE: string;
    /** the project's name in generated text (`The <NAME> database, …`) */
    NAME: string;
    /** id root: the stack's elements are `<ID>.db` (logic in `<ID>.db.functions`), `<ID>.files`, `<ID>.edge`, `<ID>.cand` (the platform's and outside systems' ids are in `SUPABASE_SERVICES` / `EXTERNALS`) */
    ID: string;
    /** the generated documents: id (the file is `<id>.json`) and title; the database title gets `(database from a <env> snapshot; …)` appended; `edge.contract`: the Edge Functions' contract document, relative to the specs folder */
    DOCS: { supabase: SupabaseDocConfig; edge: SupabaseDocConfig & { contract: string }; reactClient: SupabaseDocConfig };
    /** repo-relative folder of the committed snapshots (provenance in the documents) */
    SOURCES: string;
    /** the database snapshot read: `<SOURCES>/<SNAPSHOT_ENV>-schema.json` */
    SNAPSHOT_ENV: string;
    /** schemas the database snapshot reads (the system's own; Supabase's and extensions' are left out) — more than `SHOWN_SCHEMAS` */
    SNAPSHOT_SCHEMAS: string[];
    /** the database repo: its id in `repos`, URL, migrations folder */
    REPO: { id: string; url: string; migrations: string };
    /** schemas on the map */
    SHOWN_SCHEMAS: string[];
    /** schemas the Data API serves (their functions are RPC endpoints) */
    API_SCHEMAS: string[];
    DOMAINS: DomainsConfig & { minGroup: number; minEdgeGroup: number; splitAbove: number };
    EDGE: SupabaseEdgeConfig;
    /** outside systems: element id, ports by file name, hosts of direct fetch() calls; `other`: every other host */
    EXTERNALS: Record<string, { id: ElementId; name: string; technology: string; ports?: string[]; hosts?: RegExp[]; other?: boolean }>;
    /** Edge Function paths outside systems call (webhooks): path prefix → EXTERNALS key */
    INBOUND: { path: string; from: string }[];
    /** the architecture page the platform parts follow */
    SUPABASE_ARCH: string;
    /** the map's layers */
    TIERS: [Tier, ...Tier[]];
    /** the parts of the platform: element id, the config.toml section that turns it on, tier, gateway path */
    SUPABASE_SERVICES: Record<string, { id: ElementId; name: string; technology: string; description: string; toml?: string; tier?: string; path?: string; needsSchema?: string }>;
    REACT_CLIENT: ReactClientConfig;
}

// ---------- where things are written (scripts/stacks/supabase/sources.ts) ----------

/** A place in a repo file. */
export interface FileLine {
    file: string;
    line: number;
}

/** `migrationIndex(root, dir)`: where an object is created in the migrations (for `source` links only). */
export interface MigrationIndex {
    fn: (schema: string | null | undefined, name: string) => FileLine | undefined;
    table: (schema: string | null | undefined, name: string) => FileLine | undefined;
    view: (schema: string | null | undefined, name: string) => FileLine | undefined;
    trigger: (name: string) => FileLine | undefined;
    /** the timestamp prefix of the newest migration file */
    newest?: () => string | undefined;
}

/** One `[section]` of supabase/config.toml: its line and its simple values (JSON-parsed when they parse). */
export interface TomlSection {
    line: number;
    values: Map<string, { value: unknown; line: number }>;
}
/** `readToml(path)`: section name (`''` for the top) → section. */
export type Toml = Map<string, TomlSection>;

/** `snapshotIndex(text)`: (section, key) → line in the snapshot file. */
export type SnapAt = (section: string, key: string) => number | undefined;

// ---------- the database snapshot (`<SOURCES>/<SNAPSHOT_ENV>-schema.json`, the project's snapshot script) ----------

export interface SnapColumn {
    name: string;
    type: string;
    notNull?: boolean;
    default?: string | null;
    comment?: string | null;
}
export interface SnapGrant {
    role: string;
    privilege: string;
}
export interface SnapFk {
    name: string;
    columns: string[];
    refSchema: string;
    refTable: string;
    refColumns: string[];
    onDelete: string;
}
export interface SnapTable {
    schema: string;
    name: string;
    kind: string;
    comment: string | null;
    rls: boolean;
    forceRls: boolean;
    columns: SnapColumn[];
    pk: string[];
    fks: SnapFk[];
    grants: SnapGrant[];
}
export interface SnapView {
    schema: string;
    name: string;
    kind: string;
    comment: string | null;
    columns: SnapColumn[];
    reads: { schema: string; name: string }[];
    calls: { schema: string; name: string }[];
    definition: string;
    grants: SnapGrant[];
}
export interface SnapFunction {
    schema: string;
    name: string;
    args: string;
    returns: string | null;
    kind: string;
    language: string;
    securityDefiner: boolean;
    volatility: string;
    comment: string | null;
    executableBy: string[];
    body: string;
}
export interface SnapTrigger {
    schema: string;
    table: string;
    name: string;
    functionSchema: string;
    function: string;
    enabled: boolean;
    definition: string;
}
export interface SnapPolicy {
    schema: string;
    table: string;
    name: string;
    permissive: boolean;
    roles: string[];
    command: string;
    using: string | null;
    withCheck: string | null;
}
export interface SnapEnum {
    schema: string;
    name: string;
    labels: string[];
}
export interface SnapCron {
    name: string;
    schedule: string;
    active: boolean;
    command: string;
}
export interface SnapBucket {
    id: string;
    public: boolean;
    fileSizeLimit: number | null;
    allowedMimeTypes: string[] | null;
}
/** The read-only snapshot of a Supabase project's database (`npm run snapshot -- <p> db`). */
export interface DbSnapshot {
    env: string;
    takenAt: string;
    schemas: string[];
    meta: {
        postgres: string;
        role: string;
        lastMigration: string | null;
        appliedMigrations: number;
        otherSchemas: string[];
    };
    tables: SnapTable[];
    views: SnapView[];
    functions: SnapFunction[];
    triggers: SnapTrigger[];
    policies: SnapPolicy[];
    enums: SnapEnum[];
    cron: SnapCron[];
    realtime: { schema: string; table: string; name?: string }[];
    buckets: SnapBucket[];
}

// ---------- SQL facts (scripts/stacks/supabase/sql.ts) ----------

/** A possibly qualified name in SQL (`schema` null when the text does not say). */
export interface QName {
    schema: string | null;
    name: string;
}
/** What a function body, a cron command or a view touches. */
export interface Facts {
    reads: Map<string, { q: QName; ops: Set<string> }>;
    writes: Map<string, { q: QName; ops: Set<string> }>;
    calls: Map<string, QName>;
    http: { url: string | null; expr: string }[];
    unresolved: { kind: string; expr: string }[];
    /** temporary tables the body creates itself */
    temp: Set<string>;
}

/** A RangeVar of libpg_query's parse tree. */
export interface PgRangeVar {
    schemaname?: string;
    relname: string;
}
/**
 * A node of a libpg_query parse tree (SQL or PL/pgSQL) as the walkers of sql.ts read it: an object keyed by node
 * type. Only the keys read are described; the walkers visit every other value generically (`Object.values`).
 */
export interface PgNode {
    InsertStmt?: { relation: PgRangeVar; onConflictClause?: { action?: string } };
    UpdateStmt?: { relation: PgRangeVar };
    DeleteStmt?: { relation: PgRangeVar };
    MergeStmt?: { relation: PgRangeVar };
    TruncateStmt?: { relations?: PgNode[] };
    SelectStmt?: { intoClause?: { rel?: PgRangeVar } };
    CreateStmt?: { relation?: PgRangeVar };
    LockingClause?: { lockedRels?: PgNode[] };
    RangeVar?: PgRangeVar;
    FuncCall?: { funcname?: PgNode[]; args?: unknown };
    CommonTableExpr?: { ctename?: string };
    A_Const?: { sval?: { sval: string } };
    String?: { sval?: string };
    sval?: string;
    PLpgSQL_stmt_dynexecute?: { query?: PgNode };
    PLpgSQL_stmt_dynfors?: { query?: PgNode };
    PLpgSQL_stmt_return_query?: { dynquery?: PgNode };
    PLpgSQL_expr?: { query?: string };
}

/** `supabaseVia(ids)`: how supabase-js calls travel. */
export interface SupabaseVia {
    REST: [ElementId, ElementId] | undefined;
    STORAGE: [ElementId, ElementId] | undefined;
    GW: [ElementId] | undefined;
}

/** `supabaseIds(els, config)`: the ids of the Supabase document (database + platform) a client points at. */
export interface SupabaseIds {
    /** `schema.name` → id (tables and views) */
    tables: Map<string, ElementId>;
    /** `public.fn` → endpoint id */
    rpcs: Map<string, ElementId>;
    /** bucket name → id */
    buckets: Map<string, ElementId>;
    gateway: ElementId | null;
    rest: ElementId | null;
    storage: ElementId | null;
    auth: ElementId | null;
}

/** One route `routeMatcher` matches: `full` with `:param` or `{param}` segments. */
export interface RouteItem<V> {
    full: string;
    method: string | undefined;
    value: V;
}

// ---------- the supabase-js scanner (scripts/stacks/supabase/supabase-js.ts) ----------

/** A literal an expression folds to (`valueOf`); `undefined` when the code does not say. */
export type Value = string | number | boolean | undefined | Value[] | { [key: string]: Value };

/** `makeValues(ts, checker)`: value folding over one program. */
export interface Values {
    strip: { (e: TS.Expression): TS.Expression; (e: TS.Expression | undefined): TS.Expression | undefined };
    symbolOf: (node: TS.Node) => TS.Symbol | undefined;
    declOfCallee: (callee: TS.Expression) => TS.Declaration | undefined;
    valueOf: (e: TS.Expression | undefined, depth?: number) => Value;
    name: (e: TS.Expression | undefined) => string | undefined;
}

/** `supabaseCall`: what one call expression is, as a supabase-js call. */
export type SupabaseCall =
    | { kind: 'bucket'; bucket: string; access: 'read' | 'write'; op: string }
    | { kind: 'table'; schema: string; table: string; op: string }
    | { kind: 'rpc'; schema: string; fn: string }
    /** the shape matched but the name did not fold */
    | { kind: 'unresolved'; code: string; expr: string }
    /** a supabase-js call that reaches nothing (`.from(b).<other op>`) */
    | { kind: 'skip' }
    | { kind: 'invoke'; name: Value; method: string | undefined; arg: TS.Expression | undefined; expr: string }
    | { kind: 'auth'; call: string };

// ---------- domains (scripts/stacks/supabase/domains.ts) ----------

/** The part of `DOMAINS` (`SupabaseConfig`) that `makeDomains` reads. */
export interface DomainsConfig {
    synonyms: Record<string, string>;
    extraWords: string[];
    notDomains: string[];
    minTables: number;
}

/** A part's domain and the rule that gave it; `fold` sets `domain: 'other', rule: 'small'` on small groups. */
export interface DomainAssignment {
    domain: string;
    rule: string;
    group?: string;
}

/** `makeDomains(cfg, publicTables)`. */
export interface Domains {
    tableDomain: (t: string) => string;
    nameDomain: (name: string) => string | undefined;
    dataDomain: (uses: Iterable<{ table: string; weight: number }>) => string | undefined;
    fold: <K, A extends DomainAssignment>(assigned: Map<K, A>, min: number) => Map<K, A>;
    vocab: Set<string>;
}

// ---------- the Edge Functions (scripts/stacks/supabase/edge.ts → edge-spec.ts) ----------

/** A unit of the Edge Functions: a top-level function or a class method, with what it does. */
export interface EdgeUnit {
    key: string;
    file: string;
    name: string;
    className: string | undefined;
    line: number;
    body: TS.Node;
    /** target unit key → the call */
    calls: Map<string, { target: EdgeUnit; line: number }>;
    tables: Map<string, { schema: string; table: string; op: string; line: number }>;
    rpcs: Map<string, { schema: string; fn: string; line: number }>;
    buckets: Map<string, { bucket: string; access: 'read' | 'write'; op: string; line: number }>;
    ports: Map<string, { port: string; method: string; line: number }>;
    http: { line: number; url: string | null; method: string | undefined; expr: string }[];
    unresolved: { kind: string; line: number; expr: string }[];
    /** the options of the access check the unit runs itself (`authenticate(req, { … })`), folded */
    auth: Value;
    guards: Set<string>;
}
/** A route of a `defineRouter` (values folded from the code: whatever the literal is). */
export interface EdgeRoute {
    fn: string;
    file: string;
    line: number;
    basePath: Value;
    method: string;
    path: Value;
    summary: Value;
    authRequired: Value;
    disableAuthentication: Value;
    authentication: Value;
    security: Value;
    requestDto: string | undefined;
    responseDto: string | undefined;
    handler: EdgeUnit | undefined;
    handlerText: string | undefined;
}
/** `analyzeEdgeFunctions` result. */
export interface EdgeAnalysis {
    units: EdgeUnit[];
    routes: EdgeRoute[];
    routeIssues: { kind: string; file: string; line: number; expr: string }[];
    files: string[];
}

/** An HTTP call out of Postgres (pg_net in a function, an HTTP cron job, a database webhook): edge-spec.ts resolves it. */
export interface DbHttpCall {
    from: ElementId;
    fromMethod?: string;
    url: string;
    channel: string;
    label?: string;
    source: Site | undefined;
    /** its entry in the database document's unresolved report (dropped there once resolved) */
    entry: UnresolvedEntry;
}

// ---------- a React + supabase-js client app (scripts/stacks/supabase/react-client.ts → react-client-spec.ts) ----------

/** A place in the client app's repo. */
export interface CandSite {
    file: string;
    line: number;
}
/** A string argument: a literal, else the parameter of the unit it comes from (bound by the caller), else the string literals of its type. */
export interface StringArg {
    value?: string;
    param?: string;
    union?: string[];
}
/** What a unit or a port method does itself. */
export type CandEffect =
    | (Extract<SupabaseCall, { kind: 'bucket' | 'table' | 'rpc' | 'auth' }> & { site: CandSite })
    | { kind: 'edge'; name: StringArg; method: string | undefined; site: CandSite; expr: string }
    | { kind: 'unresolved'; code: string; expr: string; site: CandSite }
    | { kind: 'fetch'; url: string | null; site: CandSite; expr: string };
/** A call of another port method (`port`: `domain#name`) or of the seam (`seam`: the seam function's key). */
export interface CandRef {
    port?: string;
    seam?: string;
    site: CandSite;
}
/** A port method: what its live adapter does (folded through local helpers); `stub`: the «scheduled in story …» message. */
export interface CandPort {
    key: string;
    domain: string;
    name: string;
    file: string;
    line: number;
    effects: CandEffect[];
    calls: CandRef[];
    stub: string | undefined;
}
/** A function of the seam (src/api/live), folded like a port method. */
export interface CandSeam {
    key: string;
    name: string;
    file: string;
    line: number;
    effects: CandEffect[];
    calls: CandRef[];
}
/** A route of `src/app/routes.tsx`: its evaluated path and the screen file its `lazy` imports. */
export interface CandRoute {
    path: string;
    title: Value;
    owner: Value;
    nav: Value;
    screen: string;
    file: string;
    line: number;
}
/** A route screen or a root of the app shell, and the port methods it reaches. */
export interface CandRoot {
    file: string;
    kind: 'screen' | 'app';
    main: { name: string; line: number };
    reach: { port: string; site: CandSite }[];
}
/** `analyzeReactClient` result. */
export interface ReactClientAnalysis {
    routes: CandRoute[];
    routeIssues: { kind: string; file: string; line: number; expr: string }[];
    ports: CandPort[];
    seam: CandSeam[];
    roots: CandRoot[];
    /** the owners file `OWNERS`: backend object → domain (folded) */
    owners: Exclude<Value, undefined>;
    files: number;
}
