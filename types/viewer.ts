// Hand-written shapes of the viewer (viewer/src outside the core): what spec-adapter.ts builds from the merged set, the
// model tree model.ts makes of it (with the layout's placement written onto its nodes), folded relations, scenarios
// with view ids and envelopes. Spec document shapes come from types/spec.d.ts, the core's results from types/core.ts.
// Types only: nothing in this file runs. The scene's own state (three.js objects per node) is local to the scene (viewer/src/scene-types.ts).
import type { Access, Column, Contract, Element, ElementId, ElementType, EdgeId, Facets, MethodName, Provenance, Source, Channel, Tier, TierId, Repo } from './spec.d.ts';
import type { MergedSet, PathStep } from './core.ts';

/** spec-adapter.ts: an endpoint folded into its component. */
export interface ViewEndpoint {
    id: ElementId;
    method: string;
    path: string;
    title: string;
    access: Access | null;
    contract: Contract | null;
    handler: MethodName | null;
    sourceUrl: string | null;
}

/** spec-adapter.ts: a component's dependency, rebuilt from its `call` edges. */
export interface Dep {
    id: ElementId;
    name: string;
    methods: MethodName[];
}

/** spec-adapter.ts: one element (not an endpoint) as the viewer sees it. */
export interface AdaptedNode {
    id: ElementId;
    parent: ElementId | null;
    type: ElementType;
    shape: string;
    role: string;
    layer: TierId;
    title: string;
    description?: string;
    technology?: string;
    context: boolean;
    provenance: Provenance;
    source?: Source;
    sourceUrl: string | null;
    file?: string;
    endpoints: ViewEndpoint[];
    methods: MethodName[] | null;
    columns?: Column[];
    facets?: Facets;
    derivedFrom?: Element['derivedFrom'];
    confidence?: Element['confidence'];
    deps: Dep[];
}

/** spec-adapter.ts: a relation with its core channel as `kind`, endpoints folded into their components. */
export interface ViewEdge {
    id: EdgeId;
    from: ElementId;
    to: ElementId;
    kind: Channel;
    /** Legend group (model.ts `KINDS`). */
    group: string;
    title: string;
    items: string[];
    ops: string[];
    access: Access | null;
    contract: Contract | null;
    provenance: Provenance;
    fromMethod?: MethodName;
    toMethod?: MethodName;
    via: ElementId[];
    endpoint?: ElementId;
    facets?: Facets;
}

/** spec-adapter.ts `adaptSpecs` → `meta`. */
export interface AdapterMeta {
    docs: { name: string; title: string }[];
    repos: Record<string, Repo>;
    counts: { elements: number; edges: number };
    nofacets: boolean;
}

/** spec-adapter.ts `adaptSpecs` result: what model.ts `buildModel` takes. */
export interface RawModel {
    meta: AdapterMeta;
    nodes: AdaptedNode[];
    edges: ViewEdge[];
    merged: MergedSet;
    nodeOf: (id: ElementId) => ElementId;
    endpointOwner: Map<ElementId, ElementId>;
}

/** A size in world units (x = w, y = h, z = d). */
export interface Size3 {
    w: number;
    h: number;
    d: number;
}
export interface Point3 {
    x: number;
    y: number;
    z: number;
}

/**
 * model.ts: a node of the tree. An adapted element, or the synthetic «Outside the slice» group (`type: 'group'`, which
 * has no source, methods or deps). layout.ts writes its placement into the `_` fields.
 */
export interface ViewNode extends Omit<AdaptedNode, 'type' | 'provenance' | 'sourceUrl' | 'methods' | 'deps'> {
    type: ElementType | 'group';
    provenance?: Provenance;
    sourceUrl?: string | null;
    methods?: MethodName[] | null;
    deps?: Dep[];
    children: ViewNode[];
    leafCount: number;
    degree: number;
    /** model.ts `setDepths`. */
    depth?: number;
    // ---- layout.ts ----
    _size?: Size3;
    /** Min corner on the floor; y = bottom. */
    _pos?: Point3;
    _plate?: boolean;
    _column?: boolean;
    _rel?: { x: number; z: number };
    _rail?: boolean;
    _railIndex?: number;
}

/** A node that layout.ts has placed: its size and position are set. */
export type PlacedNode = ViewNode & { _size: Size3; _pos: Point3 };

/** scenario.ts `bridgeOf`: per node, the relations a bridge may follow out of it (cached on the model). */
export type BridgeOut = Map<ElementId, { to: ElementId; e: ViewEdge }[]>;

/** model.ts `buildModel` result. */
export interface Model {
    meta: AdapterMeta;
    nodes: Map<ElementId, ViewNode>;
    roots: ViewNode[];
    edges: ViewEdge[];
    tech: Set<ElementId>;
    tiers: Tier[];
    merged: MergedSet;
    nodeOf: (id: ElementId) => ElementId;
    _bridgeOut?: BridgeOut;
}

/** model.ts `foldEdges`: raw relations folded to visible nodes, one per (from, to, group). `id` = `from|to|group`. */
export interface FoldedEdge {
    id: string;
    from: ElementId;
    to: ElementId;
    group: string;
    raw: ViewEdge[];
}

/** model.ts `routeVia`: a drawn line — a hop of the folded relations' routes, with the ones it carries. */
export interface RoutedEdge extends FoldedEdge {
    members: string[];
    transit: boolean;
}

/** model.ts `search` result. */
export interface SearchHit {
    node: ViewNode;
    endpoint?: ViewEndpoint;
    score: number;
    kind: number;
}

/** model.ts `trace` / `traceNode`: a Path step on view ids (`kind` = core channel; a break step stays on its node). */
export type ViewStep = PathStep & { to: ElementId; kind: PathStep['channel'] };

/** scenario.ts: the bridge into a step — the chain of relations from the previous steps to where it starts. */
export interface Bridge {
    nodes: ElementId[];
    edges: ViewEdge[];
}

/** scenario.ts `scenariosOf`: a resolved step with view ids. */
export type ScenarioStep = (
    | { caption: string; duration: number | null; kind: 'element'; element: ElementId; edges: ViewEdge[]; contract?: undefined }
    | { caption: string; duration: number | null; kind: 'edge'; from: ElementId; to: ElementId; channel: Channel | null; contract: Contract | null; edges: ViewEdge[] }
) & { bridge?: Bridge | null; journey?: CinemaLeg[] };

/** scenario.ts `scenariosOf`: a scenario of the loaded specs. */
export interface ViewScenario {
    id: ElementId;
    title: string;
    description: string;
    steps: ScenarioStep[];
    flow?: CinemaPlan;
}

/** scenario.ts `stepView`: what a step lights at the current expansion. */
export interface StepView {
    nodes: Set<ElementId>;
    keys: Set<string>;
    bridge: { nodes: Set<ElementId>; keys: string[] };
}

// ---------- envelopes.ts ----------
export type Side = 'request' | 'response';

/** Contract documents by name; `pending(doc)`: it is being loaded (load.ts loads contracts on first use). */
export type ContractDocs = Map<string, unknown> & { pending?: (doc: string) => boolean };

/** An authored envelope of the client layer (`envelopes` of a spec: open JSON, read as far as this). */
export interface AuthoredEnvelope {
    title?: string;
    fields?: Record<string, string>;
}

/** envelopes.ts `envelopeContext`. */
export interface EnvelopeContext {
    authored: Record<string, AuthoredEnvelope>;
    docs: ContractDocs;
    cache: Map<string, Envelope>;
}

/** envelopes.ts `envelopeOf`: one object a relation carries. */
export interface Envelope {
    key: string;
    title: string;
    authored: boolean;
    fields: { name: string; label: string }[];
    total: number;
}

/** An envelope and how many relations carry it. */
export interface EnvelopeCount {
    env: Envelope;
    n: number;
}
export type EnvelopeSides = Record<Side, EnvelopeCount[]>;

/** envelopes.ts `chipsOf`. */
export interface Chip {
    side: Side;
    env: Envelope;
    others: number;
}

/** envelopes.ts `shapeOf`: the object behind an envelope key, field by field. */
export interface ObjectShape {
    key: string;
    title: string;
    schemaName: string;
    fields: ShapeField[];
    more: number;
    loaded: boolean;
    pending: boolean;
}
export interface ShapeField {
    name: string;
    label: string;
    type: string;
    required: boolean;
    children: { name: string; type: string; required: boolean }[];
    childMore: number;
}
export interface SideShape {
    side: Side;
    shape: ObjectShape;
}

// ---------- panel.ts ----------
/** One OpenAPI operation as the panel reads it (contract documents are open JSON). */
export interface OpenApiOperation {
    operationId?: string;
    parameters?: { name: string; in: string; required?: boolean; schema?: unknown }[];
    requestBody?: { content?: Record<string, { schema?: unknown }> };
    responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

/** panel.ts `contractIndex`: the loaded contract documents and their OpenAPI operations by `doc#operationId`. */
export interface ContractApi {
    docs: ContractDocs;
    ops: Map<string, { path: string; method: string; op: OpenApiOperation }>;
}

/** A Path shown on the map and in the panel (focus.ts `startPath`). */
export interface ViewPath {
    title: string;
    steps: ViewStep[];
    callers: string[];
    start: ElementId;
    method: MethodName;
}

/** What the panel's renderers read besides the thing they show. */
export interface PanelContext {
    model: Model;
    api: ContractApi;
    focus: ElementId | null;
    /** What is open at rest (the client layer or the technical overview). */
    rest?: Set<ElementId>;
    env?: EnvelopeContext;
    folded?: RoutedEdge[];
    scenarios?: ViewScenario[];
}

/** Semantic cinema journey; response edges retain their forward identity and travel backwards. */
export interface CinemaLeg {
    kind: 'request' | 'response' | 'delivery' | 'processing' | 'attention' | 'independent' | 'unspecified';
    step: number;
    from: ElementId;
    to: ElementId;
    edge?: ViewEdge;
    contract: Contract | null;
}
export interface CinemaPlan { legs: CinemaLeg[] }

/** A visible hop or a held semantic boundary on a cinema step's elapsed timeline. */
export interface CinemaSegment {
    leg: CinemaLeg;
    from: ElementId;
    to: ElementId;
    key?: string;
    frame?: ElementId[];
    hold?: boolean;
    reverse: boolean;
    ms: number;
}

/** Read-only cinema cursor exposed by the viewer's debug API. */
export interface CinemaPlayback {
    on: boolean;
    playing: boolean;
    phase: 'title' | 'step' | 'end';
    step: number | null;
    ms: number;
    elapsed: number;
    segment?: number;
    leg?: CinemaSegment;
    journey?: CinemaLeg[];
    track: { from: number; to: number; progress: number } | null;
}
