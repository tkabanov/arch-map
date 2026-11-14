// Hand-written shapes of the Nest stack: a NestJS backend (Sequelize models, DI, routes, events) and the Vue / Nuxt
// frontends that call it (scripts/stacks/nest/{backend,frontend,to-spec*}.ts; the project's generate.ts does the slice
// analysis). `NestConfig` is what the stack reads of a project config: <projects dir>/<p>/config.ts satisfies it. Types only.
import type { Site } from '../spec.d.ts';

// ---------- the stack config (what <projects dir>/<p>/config.ts exports) ----------

/** A frontend app: where its code lives and how a file is grouped into an area. */
export interface NestFrontendConfig extends FrontendScanConfig {
    title: string;
    technology: string;
    description: string;
    /** the app's folder in the target checkout */
    dir: string;
    /** the app's repository URL (`repos[app].url` of the spec) */
    repoUrl: string;
    /** source-link template: `{commit}`, `{file}`, `{line}`; default `${repoUrl}/blob/{commit}/{file}#L{line}` (GitHub; GitLab: `${repoUrl}/-/blob/{commit}/{file}#L{line}`) */
    blobUrl?: string;
    /** a file's area (a module of the app) from its path under the app */
    area: (rel: string) => string;
}

/** What the Nest stack reads of a project config (`satisfies` it: `Satisfies<NestConfig, typeof import('./config.ts')>`). */
export interface NestConfig {
    /** repo-relative path of the config file: `source.config` of declared elements is `${CONFIG_SOURCE}#<export>` */
    CONFIG_SOURCE: string;
    /** the document the builder writes */
    DOC: { id: string; title: string };
    /** id root of the project's elements: the backend app is `${ID}.${BACKEND.id}`, a frontend `${ID}.${fe.id}`, its buses under the app */
    ID: string;
    /** the backend's OpenAPI contract, relative to the document (`contract.doc` of REST endpoints) */
    CONTRACT_DOC: string;
    /** backend feature folders (under src/modules) drawn in full; what they touch outside is context */
    BACKEND_SCOPE: string[];
    FRONTENDS: NestFrontendConfig[];
    BACKEND: { id: string; title: string; technology: string; description: string; dir: string; repoUrl: string; blobUrl?: string };
    /** injected classes that talk to an outside system: class name → the channel */
    EXTERNAL_CLIENTS: Record<string, { external: string; kind: string; technology: string; title: string; protocol?: string }>;
    /** outside systems by key */
    EXTERNALS: Record<string, { title: string; description: string; technology: string }>;
    /** method decorators whose methods a dispatcher class runs (an event channel) */
    EVENT_DECORATORS: Record<string, { dispatcher: string; dispatchMethod: RegExp; title: string; technology: string }>;
    /** channels code does not show: who calls a controller method from outside */
    INBOUND: { from: string; controller: string; method: string; kind: string; title: string; technology: string }[];
    /** data-access calls that read; every other call on a model or repository is a write */
    READ_METHODS: Set<string>;
    /** the database (declared) */
    DATABASE: { id: string; title: string; technology: string; description: string };
    /** frontend calls to these backend paths that match no route are reported */
    SLICE_PATHS: RegExp;
    /** domain events: the bus, the handler decorator */
    DOMAIN_EVENTS: { bus: string; decorator: string; technology: string };
}

// ---------- the backend (scripts/stacks/nest/backend.ts `scanBackend`) ----------

/** A class referenced by name, and the file it comes from (null when not found). */
export interface ClassRef {
    name: string;
    file: string | null;
}
/** An entry of a Nest module's `imports` / `providers` / … (`dynamic`: `X.forRoot(…)` → `forRoot`). */
export interface ModuleRef extends ClassRef {
    dynamic?: string;
}
/** The arrays of a `@Module({ … })`. */
export interface NestModule {
    imports: ModuleRef[];
    providers: ModuleRef[];
    controllers: ModuleRef[];
    exports: ModuleRef[];
    models: { name: string; file: string }[];
}
/** A constructor parameter (DI). */
export interface BackendDep {
    param: string;
    typeName: string | null;
    typeFile: string | null;
    line: number;
    /** `@InjectModel(X)` */
    model?: string;
    modelFile?: string;
    /** `@Inject(TOKEN)` */
    token?: string;
}
/** What one member calls: an entry exists only for members that call something. */
export interface MethodFacts {
    calls: { param: string; method: string; line: number }[];
    model: { method: string; line: number }[];
    statics: { name: string; method: string; line: number }[];
    publishes: { name: string; file: string; line: number }[];
    self: { method: string; line: number }[];
    unresolved: { expr: string; line: number }[];
}
export interface BackendRoute {
    method: string;
    path: string;
    handler: string;
    operationId: string;
    auth: string;
    system: boolean;
    body: string | null;
    doc: string;
    line: number;
}
export interface EventHandler {
    decorator: string;
    method: string;
    argName: string | null;
    argFile: string | null;
    line: number;
}
export interface ModelColumn {
    name: string;
    type: string;
    nullable: boolean;
    pk: boolean;
}
export interface ModelFk {
    rel: string;
    field: string;
    target: string;
    targetFile: string;
    through: string | null | undefined;
    line: number;
}
export type ClassKind = 'module' | 'controller' | 'model' | 'gateway' | 'injectable' | 'class';
/** One class of the backend as `scanBackend` reads it. */
export interface ClassInfo {
    name: string;
    file: string;
    rel: string;
    line: number;
    doc: string;
    kind: ClassKind;
    /** local name → file (or `pkg:<specifier>`) */
    imports: Map<string, string>;
    deps: BackendDep[];
    /** param → methods called on it */
    calls: Map<string, Set<string>>;
    /** imported name → static methods called on it */
    staticCalls: Map<string, Set<string>>;
    /** domain events: `publish(new X())` */
    published: { name: string; file: string; line: number }[];
    methods: Map<string, MethodFacts>;
    /** every method / function-valued property / accessor → its declaration line */
    memberLines: Map<string, number>;
    routes: BackendRoute[];
    eventHandlers: EventHandler[];
    module: NestModule | null;
    columns: ModelColumn[];
    fks: ModelFk[];
    tableName: string | null;
    /** ABaseRepository<Model>: the model this repository wraps */
    baseModel: { name: string; file: string } | null;
    /** the extended class, when there is one */
    base: ClassRef | null;
    /** this.model.<method>(…) */
    modelCalls: Set<string>;
    /** controllers: the `@Controller('…')` path */
    prefix?: string;
}
/** `scanBackend` result. */
export interface BackendScan {
    /** `${file}#${name}` → class */
    classes: Map<string, ClassInfo>;
    byName: Map<string, ClassInfo[]>;
    find: (name: string, file?: string | null) => ClassInfo | null;
    srcDir: string;
    /** `${file}#NAME` → string value of a top-level const */
    constants: Map<string, string>;
}

// ---------- the frontends (scripts/stacks/nest/frontend.ts) ----------

/** The part of a `FRONTENDS` entry (`NestFrontendConfig`) that `scanFrontend` reads. */
export interface FrontendScanConfig {
    id: string;
    roots: string[];
    /** callee name → path suffix the call adds (`usePaymentDetail` → `/:p/detail`) */
    prefixCalls?: Record<string, string>;
}

/** One API call a frontend makes: a literal that looks like a backend route. */
export interface FrontendCall {
    file: string;
    rel: string;
    line: number;
    method: string | null;
    path: string;
    raw: string;
}

/** `scanFrontend` result. */
export interface FrontendScan {
    calls: FrontendCall[];
    /** rel → rels of the files that import it */
    importers: Map<string, Set<string>>;
    /** `${importer rel}|${imported rel}` → line of the first import statement */
    importLines: Map<string, number>;
}

// ---------- the analysis handed to the spec builder (the project's generate.ts → scripts/stacks/nest/to-spec.ts) ----------

/** A route with the controller it belongs to. */
export type ControllerRoute = BackendRoute & { controller: ClassInfo };
/** A frontend call matched to a route (`context`: the route is outside the slice). */
export type RoutedCall = FrontendCall & { route: ControllerRoute; context?: boolean };
/** A frontend file of an area (`role`: api client, view, plain module). */
export interface AreaItem {
    rel: string;
    fqn: string;
    role: 'api' | 'view' | 'module';
}
/** One frontend as generate.ts hands it to the builder. */
export interface FrontendElements {
    fe: NestFrontendConfig;
    areas: Map<string, AreaItem[]>;
    sha: string;
    /** rel → its calls into the backend */
    files: Map<string, { calls: RoutedCall[] }>;
    /** rel of an importer → the API files it imports */
    users: Map<string, Set<string>>;
    importLines: Map<string, number>;
    elementOf: (rel: string) => { area: string; fqn: string };
}
/** A class-level relation (coarser than per-method), one per (from, to, kind): the coverage reference for per-method edges. */
export interface Relation {
    from: string;
    to: string;
    kind: string;
    items: string[];
    operationIds: string[];
    sites: Site[];
    technology: string | undefined;
    title: string | undefined;
    ops: string[];
    via: { param: string; type: string } | undefined;
}
/** A foreign key between two tables of the slice. */
export interface FkRel {
    from: string;
    to: string;
    field: string;
    rel: string;
    target: string | null;
    site: Site;
}
/** A frontend call to a slice path that matches no route. */
export interface UnmatchedCall {
    repo: string;
    file: string;
    line: number;
    method: string | null;
    path: string;
}
/** The part of an OpenAPI document the builder reads (the backend's contract under `<projects dir>/<p>/specs/contracts/`, open JSON). */
export interface OpenApiDoc {
    paths?: Record<string, Record<string, unknown>>;
}
/** `buildSpec(x)`: the analysis of a Nest backend and its frontends. */
export interface NestAnalysis {
    config: NestConfig;
    be: BackendScan;
    /** class → element id (the slice) */
    fqn: Map<ClassInfo, string>;
    owner: Map<ClassInfo, ClassInfo>;
    targetOf: (cls: ClassInfo) => string | null;
    contextFqn: (cls: ClassInfo) => string | null;
    tableFqn: (model: ClassInfo, context: boolean) => string;
    tables: Map<ClassInfo, { fqn: string; context: boolean }>;
    kindOf: (cls: ClassInfo) => string;
    /** folder → module → components */
    apiFolders: Map<string, Map<ClassInfo, ClassInfo[]>>;
    contextModules: Map<ClassInfo, string>;
    scopeComponents: ClassInfo[];
    feElements: FrontendElements[];
    relations: Map<string, Relation>;
    fkRels: FkRel[];
    unmatched: UnmatchedCall[];
    commits: Record<string, string>;
    openapi: OpenApiDoc;
}
