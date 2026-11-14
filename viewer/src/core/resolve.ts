// Resolution over merged specs (docs/architecture.md AD-7, AD-8, AD-9): effective contract and access of an
// edge, contract pointers, scenario steps. Pure ESM: no DOM, no three.js, no Node built-ins — shared by
// scripts/ and the viewer. The only implementation of these rules.
import type { EdgeStep, ElementStep, MergedCore, ResolvedScenarios, ResolvedStep, SchemaObject } from '../../../types/core.ts';
import type { Access, Contract, Edge, Element, ElementId, Step } from '../../../types/spec.d.ts';
import { isRail } from './tier.ts';

/** True when `id` is `rootId` or one of its descendants (parents as set by core/merge.ts). */
export function isWithin(merged: Pick<MergedCore, 'byId'>, id: ElementId, rootId: ElementId): boolean {
    let cur: Element | null | undefined = merged.byId.get(id);
    for (let guard = 0; cur && guard < 64; guard++) {
        if (cur.id === rootId) return true;
        cur = cur.parent ? merged.byId.get(cur.parent) : null;
    }
    return false;
}

const endpointOf = (merged: Pick<MergedCore, 'byId'>, id: ElementId): Element | null => {
    const el = merged.byId.get(id);
    return el?.type === 'endpoint' ? el : null;
};

/** `edge.contract ?? (to is endpoint ? to.contract : none)` (AD-7). */
export const effectiveContract = (merged: Pick<MergedCore, 'byId'>, edge: Edge): Contract | null => edge.contract ?? endpointOf(merged, edge.to)?.contract ?? null;

/** `edge.access ?? (to is endpoint ? to.access : none)` (AD-9). */
export const effectiveAccess = (merged: Pick<MergedCore, 'byId'>, edge: Edge): Access | null => edge.access ?? endpointOf(merged, edge.to)?.access ?? null;

/** Canonical object key of one side of a contract: `doc + pointer` (AD-7), or null. */
export const contractKey = (contract: Contract | null | undefined, side: 'request' | 'response'): string | null => (contract?.[side] ? `${contract.doc}${contract[side]}` : null);

/** Splits an object key (`contracts/x.json#/$defs/Name`) into { doc, pointer }. */
export function splitKey(key: string): { doc: string; pointer: string } {
    const i = key.indexOf('#');
    return i < 0 ? { doc: key, pointer: '' } : { doc: key.slice(0, i), pointer: key.slice(i) };
}

/** Resolves a local JSON pointer (`#/components/schemas/X`) inside a parsed document; undefined when absent. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
    if (!pointer.startsWith('#')) return undefined;
    const parts = pointer.slice(1).split('/').slice(1).map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = doc;
    for (const p of parts) {
        if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}

/**
 * Property names of a schema object, following local `$ref`s and `allOf` inside the same document.
 * Returns a Set (empty when the schema declares none).
 */
export function schemaProperties(doc: unknown, schema: unknown, depth = 0): Set<string> {
    const out = new Set<string>();
    if (!schema || typeof schema !== 'object' || depth > 8) return out;
    const s = schema as SchemaObject; // contract documents are open JSON: read what is there
    if (typeof s.$ref === 'string') for (const p of schemaProperties(doc, resolvePointer(doc, s.$ref), depth + 1)) out.add(p);
    for (const p of Object.keys(s.properties ?? {})) out.add(p);
    for (const part of s.allOf ?? []) for (const p of schemaProperties(doc, part, depth + 1)) out.add(p);
    return out;
}

/**
 * Resolves one scenario step. Element step → { kind: 'element', element }. Edge step → every core edge whose
 * `from` is the step's `from` or a descendant and whose `to` is the step's `to` or a descendant, filtered by
 * `channel` (AD-8), and the pairs of edges that make that trip through a rail (stepEdges), plus `contract` = the step's own contract, else the first effective contract among them.
 * `missing` lists ids the step names that are not loaded.
 */
const isElementStep = (step: Step): step is ElementStep => (step as { element?: unknown }).element !== undefined;

export function resolveStep(merged: MergedCore, step: Step): ResolvedStep {
    if (isElementStep(step)) {
        const ok = merged.byId.has(step.element);
        return { kind: 'element', caption: step.caption, duration: step.duration ?? null, element: step.element, edges: [], contract: null, missing: ok ? [] : [step.element] };
    }
    const missing = [step.from, step.to].filter((id) => !merged.byId.has(id));
    const edges = missing.length ? [] : stepEdges(merged, step);
    let contract: Contract | null = step.contract ?? null;
    if (!contract) for (const e of edges) if ((contract = effectiveContract(merged, e))) break;
    return { kind: 'edge', caption: step.caption, duration: step.duration ?? null, from: step.from, to: step.to, channel: step.channel ?? null, edges, contract, missing };
}

/**
 * The core edges of an edge step: direct ones (from inside `from` to inside `to`), and the ones that go through a rail
 * (a bus, a queue, a job) — into it from inside `from`, and on out of the same topic (`toMethod` in = `fromMethod`
 * out) to inside `to` — as one step: both edges, in order.
 */
function stepEdges(merged: MergedCore, step: EdgeStep): Edge[] {
    const ok = (e: Edge) => !step.channel || e.channel === step.channel;
    const out = merged.edges.filter((e) => ok(e) && isWithin(merged, e.from, step.from) && isWithin(merged, e.to, step.to));
    const have = new Set(out.map((e) => e.id));
    for (const a of merged.edges) {
        if (!ok(a) || !isRail(merged.byId.get(a.to)) || !isWithin(merged, a.from, step.from) || isWithin(merged, a.to, step.to)) continue;
        for (const b of merged.edges) {
            if (b.from !== a.to || !ok(b) || !isWithin(merged, b.to, step.to)) continue;
            if (a.toMethod && b.fromMethod && a.toMethod !== b.fromMethod) continue; // another topic of the same bus
            for (const e of [a, b])
                if (!have.has(e.id)) {
                    have.add(e.id);
                    out.push(e);
                }
        }
    }
    return out;
}

/**
 * Resolves every scenario of a merged set. Returns { scenarios, problems } where each scenario carries
 * `resolved` steps and each problem is { doc, id, message, at } (`at`: a text to locate the line by — the
 * step's caption as written in JSON). Strict callers fail on any problem; the viewer drops broken steps.
 */
export function resolveScenarios(merged: MergedCore): ResolvedScenarios {
    const problems: ResolvedScenarios['problems'] = [];
    const scenarios: ResolvedScenarios['scenarios'] = [];
    for (const s of merged.scenarios ?? []) {
        const resolved: ResolvedStep[] = [];
        s.steps.forEach((step, i) => {
            const r = resolveStep(merged, step);
            const at = JSON.stringify(step.caption);
            const where = `scenario ${s.id}, step ${i + 1}`;
            for (const id of r.missing) problems.push({ doc: s.doc, id, message: `${where}: "${id}" does not exist`, at: JSON.stringify(id) });
            if (r.kind === 'edge' && !r.missing.length) {
                if (!r.edges.length)
                    problems.push({
                        doc: s.doc,
                        id: s.id,
                        message: `${where}: no ${r.channel ?? 'core'} edge from "${r.from}" to "${r.to}" (or their descendants)`,
                        at,
                    });
                else if (!r.contract) problems.push({ doc: s.doc, id: s.id, message: `${where}: no contract on any matched edge and none on the step`, at });
            }
            resolved.push(r);
        });
        scenarios.push({ ...s, resolved });
    }
    return { scenarios, problems };
}
