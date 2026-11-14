// The shared state of `buildSpec` (to-spec.ts) and the helpers its passes use: the elements and edges being
// accumulated, the OpenAPI operations, the per-method tables. Each pass (to-spec-api.ts, to-spec-methods.ts,
// to-spec-frontend.ts) takes this context and adds to it.
import type { Access, Contract, Element, Site, ConfigSource } from '../../../types/spec.d.ts';
import type { ElementDraft, UnresolvedEntry } from '../../../types/generator.ts';
import type { BackendRoute, ClassInfo, NestAnalysis } from '../../../types/stacks/nest.ts';

/** An edge as the builder hands it in (`from`/`to` may be missing: then there is no edge). */
export interface EdgeInput {
    from: string | null | undefined;
    to: string | null | undefined;
    channel: string;
    fromMethod?: string;
    toMethod?: string;
    label?: string;
    ops?: string[];
    site?: Site;
    /** the config path of a declared edge */
    declared?: string;
    facets?: Record<string, unknown>;
    contract?: Contract;
}
/** An edge being accumulated: ops and sites united, the first label/facets kept. */
export interface EdgeAcc {
    id: string;
    from: string;
    to: string;
    channel: string;
    fromMethod: string | undefined;
    toMethod: string | undefined;
    label: string | undefined;
    ops: Set<string>;
    sites: Map<string, Site>;
    declared: string | undefined;
    facets: Record<string, unknown> | undefined;
    contracts: Map<string | undefined, Contract>;
    fkList?: { field: string; rel: string }[];
    routes?: Set<string>;
}
/** A method of a scope component as it will be listed on its element. */
export interface MethodEntry {
    name: string;
    line: number | undefined;
    unresolved: { expr: string; line: number }[];
}
/** The parts of an OpenAPI operation the builder reads (open JSON). */
type OpenApiContent = Record<string, { schema?: { $ref?: string; items?: { $ref?: string } } } | undefined>;
export interface OpenApiOp {
    operationId?: string;
    requestBody?: { content?: OpenApiContent };
    responses?: Record<string, { content?: OpenApiContent }>;
}

/** Id segment from a code name: camelCase → snake (AD-6). */
export const ident = (raw: unknown): string => {
    let id = String(raw)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/__+/g, '_');
    if (!/^[a-z_]/.test(id)) id = `x_${id}`;
    return id || 'x';
};

const METHOD_NAME = /^[A-Za-z0-9_$]+$/;
export const validMethod = (m: unknown): string | undefined => (typeof m === 'string' && METHOD_NAME.test(m) ? m : undefined);
const POINTER = /^#\/(components\/schemas|\$defs)\/[^/]+$/;
export const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
export const bySite = (a: Site, b: Site): number => cmp(a.repo, b.repo) || cmp(a.file, b.file) || a.line - b.line;
const siteKey = (s: Site): string => `${s.repo}|${s.file}|${s.line}`;

/** the same object without its undefined fields */
export const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** What `buildSpec` accumulates; every pass reads `x` and adds to the maps. */
export interface BuildCtx {
    x: NestAnalysis;
    /** the backend app's repo id */
    API: string;
    elements: Map<string, Element>;
    /** edges: accumulated, then finalized (source = first site, AD-5/AD-6) */
    edges: Map<string, EdgeAcc>;
    operations: Map<string, OpenApiOp>;
    /** route object → endpoint id */
    endpointIds: Map<BackendRoute, string>;
    usedEndpointIds: Set<string>;
    /** the event mechanisms: id → number of edges through it */
    buses: Map<string, { edges: number }>;
    /** the backend app element id: `${ID}.${BACKEND.id}` */
    apiId: string;
    domainBusId: string;
    /** publisher|subscriber|event: what the old direct event edges were (class-level coverage) */
    viaBus: Set<string>;
    /** component class → Map(name → { name, line?, unresolved: [] }) */
    methodsOf: Map<ClassInfo, Map<string, MethodEntry>>;
    unresolved: UnresolvedEntry[];
    /** `${cls}|${param}` → entry */
    packageClients: Map<string, UnresolvedEntry & { calls: Set<string> }>;
    /** repository class → Set(inherited base method names used) */
    inherited: Map<ClassInfo, Set<string>>;
}

export function makeCtx(x: NestAnalysis): BuildCtx {
    const { DOMAIN_EVENTS, BACKEND, ID } = x.config;
    const apiId = `${ID}.${BACKEND.id}`;
    return {
        x,
        API: BACKEND.id,
        elements: new Map(),
        edges: new Map(),
        operations: new Map(),
        endpointIds: new Map(),
        usedEndpointIds: new Set(),
        buses: new Map(),
        apiId,
        domainBusId: `${apiId}.bus.${ident(DOMAIN_EVENTS.bus)}`,
        viaBus: new Set(),
        methodsOf: new Map(),
        unresolved: [],
        packageClients: new Map(),
        inherited: new Map(),
    };
}

/** `source` of a declared element or edge: `path` inside the project config, named by the config's `CONFIG_SOURCE`. */
export const cfgSource = (c: BuildCtx, path: string): ConfigSource => ({ config: `${c.x.config.CONFIG_SOURCE}#${path}` });

export function addEl(c: BuildCtx, el: ElementDraft): string {
    if (c.elements.has(el.id)) return el.id;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el)) if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v;
    // a draft with the schema's fields: the document is validated before it is written (writeSpec)
    c.elements.set(el.id, out as unknown as Element);
    return el.id;
}

/**
 * e: { from, to, channel, fromMethod?, toMethod?, label?, ops?, site?, declared?: '<config path>', facets?, contract? }
 * Same id → one edge: ops and sites are united, the first label/facets stay.
 */
export function addEdge(c: BuildCtx, e: EdgeInput): EdgeAcc | null {
    if (!e.from || !e.to) return null;
    const fromMethod = validMethod(e.fromMethod);
    const toMethod = validMethod(e.toMethod);
    const id = `${e.from}${fromMethod ? `#${fromMethod}` : ''}>${e.to}${toMethod ? `#${toMethod}` : ''}:${e.channel}`;
    let acc = c.edges.get(id);
    if (!acc) {
        acc = { id, from: e.from, to: e.to, channel: e.channel, fromMethod, toMethod, label: e.label, ops: new Set(), sites: new Map(), declared: e.declared, facets: e.facets, contracts: new Map() };
        c.edges.set(id, acc);
    }
    for (const op of e.ops ?? []) acc.ops.add(op);
    if (e.site) acc.sites.set(siteKey(e.site), e.site);
    if (e.contract) acc.contracts.set(e.contract.operationId, e.contract);
    return acc;
}

// ---------- contracts (AD-7) ----------

export function readOperations(c: BuildCtx): void {
    for (const item of Object.values(c.x.openapi.paths ?? {}))
        for (const v of Object.values(item)) {
            const op = v as OpenApiOp | null;
            if (op && typeof op === 'object' && op.operationId) c.operations.set(op.operationId, op);
        }
}

const schemaRef = (content: OpenApiContent | undefined): string | undefined => {
    const schema = content?.['application/json']?.schema;
    // an array of X is still the X object (same object = same pointer)
    const ref = schema?.$ref ?? schema?.items?.$ref;
    return ref && POINTER.test(ref) ? ref : undefined;
};

export function contractOf(c: BuildCtx, operationId: string): Contract | undefined {
    const op = c.operations.get(operationId);
    if (!op) return undefined;
    const ok = Object.keys(op.responses ?? {}).filter((code) => /^2/.test(code)).sort();
    return {
        doc: c.x.config.CONTRACT_DOC,
        operationId,
        request: schemaRef(op.requestBody?.content),
        response: ok.map((code) => schemaRef(op.responses![code].content)).find(Boolean),
    };
}

// ---------- access (AD-9) ----------

export function accessOf(route: BackendRoute): Access {
    const guards: string[] = [];
    let level: Access['level'] = 'authenticated';
    if (route.auth === 'public') level = 'public';
    else if (route.auth?.startsWith('can: ')) {
        level = 'restricted';
        guards.push(`Can(${route.auth.slice(5)})`);
    }
    if (route.system) guards.push('SystemApi');
    return clean({ level, guards: guards.length ? guards : undefined });
}
