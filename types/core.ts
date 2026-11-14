// Hand-written shapes that the schema does not describe: what viewer/src/core/ builds and returns (the merged set,
// Path steps and index, resolved scenario steps, query and parity results). Spec document shapes come from
// types/spec.d.ts (generated — do not copy them here). Types only: Node strips the file, nothing in it runs.
// Use with `import type { MergedSet } from '../../../types/core.ts'`; from not-yet-migrated JS with a one-line
// `@param {import('../../../types/core.ts').MergedSet} merged`.
import type {
    ArchMapSpecDocument,
    Channel,
    Contract,
    Edge,
    Element,
    ElementId,
    EdgeId,
    Method,
    MethodName,
    Glyph,
    Scenario,
    Step,
    Tier,
    TierId,
} from './spec.d.ts';

/** A problem found while merging or resolving: `occurrence` is which appearance of `"<id>"` in the document text. */
export interface Problem {
    doc: string;
    id?: string;
    message: string;
    occurrence?: number;
}

/** One document as merge takes it: its file name (as in index.json) and the parsed JSON. */
export interface SpecEntry {
    name: string;
    doc: ArchMapSpecDocument;
}

/** A scenario of the merged set, tagged with the document it came from. */
export type MergedScenario = Scenario & { doc: string };

/** core/merge.ts `mergeSpecs` result: every document's elements and edges in one set, with lookups. */
export interface MergedSet {
    elements: Element[];
    edges: Edge[];
    scenarios: MergedScenario[];
    envelopes: Record<string, unknown>;
    tiers: Tier[];
    /** Every document's `glyphs` in load order, one per facet: the first declaration of a facet wins (AD-13). */
    glyphs: Glyph[];
    byId: Map<ElementId, Element>;
    edgeById: Map<EdgeId, Edge>;
    docOf: Map<ElementId, string>;
    edgeDocOf: Map<EdgeId, string>;
    errors: Problem[];
    warnings: Problem[];
}

/** The part of a merged set that the pure core reads (tests and the viewer build it by hand sometimes). */
export type MergedCore = Pick<MergedSet, 'elements' | 'edges' | 'byId'> & Partial<Pick<MergedSet, 'tiers' | 'scenarios'>>;

/** One step of core/path.ts `trace`: an edge walked from a method, or an explicit break (`channel: 'break'`, no `to`). */
export interface PathStep {
    from: ElementId;
    fromMethod?: MethodName;
    to?: ElementId;
    toMethod?: MethodName;
    channel: Channel | 'break';
    label: string;
    edge?: EdgeId;
    expr?: string;
    line?: number;
    depth: number;
    /** Index of the step this one is nested in, -1 at the top. */
    parent: number;
    /** The step goes into a method that is still being walked (recursion): it ends there. */
    cycle?: true;
}

/** core/path.ts `trace` / `traceEndpoint` limits. */
export interface PathOptions {
    maxSteps?: number;
    maxDepth?: number;
}

/** core/path.ts `pathIndex`: edges by `from#fromMethod`, trigger edges by table, methods by component. */
export interface PathIndex {
    out: Map<string, Edge[]>;
    triggers: Map<ElementId, Edge[]>;
    methods: Map<ElementId, Map<MethodName, Method>>;
}

/** A scenario step that names one element. */
export type ElementStep = Extract<Step, { element: ElementId }>;
/** A scenario step from one element to another (resolved to core edges). */
export type EdgeStep = Extract<Step, { from: ElementId }>;

/** core/resolve.ts `resolveStep` result. */
export type ResolvedStep =
    | {
          kind: 'element';
          caption: string;
          duration: number | null;
          element: ElementId;
          edges: [];
          contract: null;
          missing: ElementId[];
      }
    | {
          kind: 'edge';
          caption: string;
          duration: number | null;
          from: ElementId;
          to: ElementId;
          channel: Channel | null;
          edges: Edge[];
          contract: Contract | null;
          missing: ElementId[];
      };

/** core/resolve.ts `resolveScenarios` result. */
export interface ResolvedScenarios {
    scenarios: (MergedScenario & { resolved: ResolvedStep[] })[];
    problems: (Problem & { at: string })[];
}

/** The part of a JSON Schema object that core/resolve.ts `schemaProperties` follows (contract documents are open JSON). */
export interface SchemaObject {
    $ref?: unknown;
    properties?: Record<string, unknown>;
    allOf?: unknown[];
}

/** One group of core/queries.ts `summary`: who / what, over which channel (`data` for tables), how many edges. */
export interface SummaryEntry {
    owner: Element;
    channel: Channel | 'data';
    n: number;
    /** For `tables`: ⊆ ['r', 'w']. */
    extra: string[];
}

/** core/queries.ts `summary` result. */
export interface Summary {
    in: SummaryEntry[];
    tables: SummaryEntry[];
    out: SummaryEntry[];
}

export type { Step, TierId };
