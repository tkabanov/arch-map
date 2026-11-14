// Hand-written shapes shared by every generator (scripts/, scripts/lib/, <projects dir>/<p>/): spec documents on disk, the
// unresolved report, the spec builder. What one stack's extractor hands between its modules (scan results, intermediate
// models, the stack config a project hands in) lives in types/stacks/<stack>.ts. Spec document shapes come from
// types/spec.d.ts (generated); the merged set and core results from types/core.ts. Types only: Node strips the file,
// nothing in it runs. Use with `import type { SpecBuilder } from '../../types/generator.ts'`. Nothing under types/
// imports the projects dir (check:arch, rule `generic-no-projects`, type-only imports included): a project config `satisfies`
// the stack config interface instead.
import type * as TS from 'typescript';
import type { ArchMapSpecDocument, Edge, Element, ElementId, Site } from './spec.d.ts';

/** The TypeScript compiler API module (the target's own `typescript`, loaded with `loadTs`, or arch-map's). */
export type Ts = typeof TS;

// ---------- spec documents on disk (scripts/lib/spec-io.ts, spec-set.ts) ----------

/** A problem the scripts print as `<file>:<line>: <message> (<id>)`. */
export interface SpecError {
    file: string;
    line: number;
    message: string;
    id?: string;
}

/** `loadSpec(path)`: one document read and parsed; `doc` is null when it does not read or parse. */
export interface LoadedSpec {
    path: string;
    name: string;
    text: string;
    /** As parsed: not validated yet (`validate` / `checkSpecSet` do that). */
    doc: ArchMapSpecDocument | null;
    errors: SpecError[];
}

/** An entry of a `*.unresolved.json` report: what could not be recognised, with a code location when there is one. */
export interface UnresolvedEntry {
    kind: string;
    repo?: string;
    file?: string;
    line?: number;
    expr: string;
    /** the element (and method) it is about */
    element?: string;
    method?: string;
    [field: string]: unknown;
}

// ---------- spec building shared by the code documents (scripts/lib/spec-build.ts) ----------

/**
 * An element as a builder hands it in: the spec's fields, some possibly empty (`addEl` drops those, `parent` stays).
 * Loose on purpose — the document is validated against the schema before it is written (writeSpec).
 */
export interface ElementDraft {
    id: ElementId;
    type: string;
    [field: string]: unknown;
}
/** An edge as a builder hands it in (`addEdge` makes the id and folds repeats: ops added, one site each). */
export interface EdgeDraft {
    from: ElementId;
    to: ElementId | null | undefined;
    channel: string;
    fromMethod?: string;
    toMethod?: string;
    ops?: string[];
    site?: Site;
    provenance?: string;
    [field: string]: unknown;
}

/** `specBuilder()`: elements and edges keyed by id. */
export interface SpecBuilder {
    elements: Map<ElementId, Element>;
    edges: Map<string, Edge>;
    addEl: (el: ElementDraft) => ElementId;
    addEdge: (e: EdgeDraft) => Edge;
    finishEdges: () => Edge[];
}

/**
 * Compile-time check that a project config module is what a stack reads: `export type StackConfig =
 * Satisfies<NestConfig, typeof import('./config.ts')>;` at the end of <projects dir>/<p>/config.ts. tsc fails on the alias
 * when an export is missing or has the wrong shape; Node strips it, so nothing runs.
 */
export type Satisfies<Contract, T extends Contract> = T;
