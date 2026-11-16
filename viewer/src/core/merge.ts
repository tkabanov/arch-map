// Merge of spec documents into one model (docs/architecture.md AD-1, AD-6, AD-8).
// Pure ESM: no DOM, no three.js, no Node built-ins — shared by scripts/ and the viewer.
//
// Rules enforced here (and only here):
// - element ids and edge ids are unique across all merged documents;
// - `parent`, edge `from`/`to` and system `contains` reference ids of the same document or of a
//   document named in its `requires`;
// - claims (AD-8): when at least one `system` is loaded, every `app` and `datastore` is claimed by exactly
//   one system via `contains`, and merge is the only writer of their `parent`;
// - client-layer `overrides` change only `name`/`description` of an existing element;
// - one tier list for the set: documents that declare `tiers` declare the same list, and every element's
//   `tier` is one of them (default: core/tier.ts DEFAULT_TIERS);
// - one glyph list for the set (AD-13): every document's `glyphs` in load order; a facet is declared once per
//   document, and a facet declared in two documents is declared the same way (otherwise the first one is used);
// - one edge style list (1.4), by the same rule.
//
// strict (scripts): every problem is an error. Non-strict (viewer `?docs=` subsets): references to ids
// that are not loaded are dropped with a warning instead; duplicates and claim conflicts stay errors.

import type { MergedScenario, MergedSet, Problem, SpecEntry } from '../../../types/core.ts';
import type { Edge, EdgeId, EdgeStyle, Element, ElementId, ElementType, Glyph, Tier } from '../../../types/spec.d.ts';
import { DEFAULT_TIERS } from './tier.ts';

const CLAIMABLE = new Set<ElementType>(['app', 'datastore']);

/**
 * Merges `entries` (documents in load order, index.json order) into one set. Problems carry `occurrence`: which
 * appearance of `"<id>"` in the document's text the problem is about (default 1).
 */
export function mergeSpecs(entries: SpecEntry[], { strict = true }: { strict?: boolean } = {}): MergedSet {
    const errors: Problem[] = [];
    const warnings: Problem[] = [];
    const problem = (list: Problem[]) => (doc: string, id: string | undefined, message: string, occurrence?: number) =>
        list.push({ doc, ...(id !== undefined ? { id } : {}), message, ...((occurrence ?? 0) > 1 ? { occurrence } : {}) });
    const error = problem(errors);
    const warning = problem(warnings);
    // A reference to an id that is not loaded: error when strict, dropped with a warning otherwise.
    const dangling = (doc: string, id: string | undefined, message: string) => (strict ? error : warning)(doc, id, message);

    const loaded = new Set<string>();
    for (const { name } of entries) {
        if (loaded.has(name)) error(name, undefined, `document "${name}" is loaded twice`);
        loaded.add(name);
    }

    // ---- ids: unique across documents ----
    const byId = new Map<ElementId, Element>();
    const docOf = new Map<ElementId, string>();
    const edgeById = new Map<EdgeId, Edge>();
    const elements: Element[] = [];
    for (const { name, doc } of entries) {
        const seenHere = new Map<ElementId, number>();
        for (const el of doc.elements ?? []) {
            const n = (seenHere.get(el.id) ?? 0) + 1;
            seenHere.set(el.id, n);
            if (byId.has(el.id)) {
                const other = docOf.get(el.id);
                error(name, el.id, other === name ? 'duplicate element id' : `duplicate element id (also in ${other})`, other === name ? n : 1);
                continue;
            }
            const copy = { ...el };
            byId.set(el.id, copy);
            docOf.set(el.id, name);
            elements.push(copy);
        }
    }

    // ---- tiers: one list for the merged set ----
    let tiers: Tier[] | null = null;
    let tiersDoc: string | null = null;
    for (const { name, doc } of entries) {
        if (!Array.isArray(doc.tiers)) continue;
        const ids = new Set<string>();
        for (const t of doc.tiers) {
            if (ids.has(t.id)) error(name, t.id, `tier "${t.id}" is declared twice`);
            ids.add(t.id);
        }
        const list = doc.tiers.map((t) => ({ id: t.id, title: t.title }));
        if (!tiers) {
            tiers = list;
            tiersDoc = name;
            continue;
        }
        const same = tiers.length === list.length && tiers.every((t, i) => t.id === list[i].id && t.title === list[i].title);
        if (!same) (strict ? error : warning)(name, undefined, `declares tiers that differ from those of ${tiersDoc}${strict ? '' : ` (${tiersDoc}'s are used)`}`);
    }
    tiers ??= DEFAULT_TIERS.map((t) => ({ ...t }));
    const tierIds = new Set(tiers.map((t) => t.id));
    for (const el of elements)
        if (el.tier !== undefined && !tierIds.has(el.tier)) error(docOf.get(el.id)!, el.id, `tier "${el.tier}" is not one of the tiers: ${[...tierIds].join(', ')}`);

    // ---- glyphs: one ordered list for the merged set (problems carry no id: documents sort their keys, so the
    // first `"<facet>"` in the text is an element's, not the declaration) ----
    const glyphs: Glyph[] = [];
    const glyphDoc = new Map<string, string>();
    for (const { name, doc } of entries) {
        const here = new Set<string>(); // per document, whatever other documents declared
        for (const g of doc.glyphs ?? []) {
            if (here.has(g.facet)) {
                error(name, undefined, `facet "${g.facet}" declared twice in glyphs`);
                continue;
            }
            here.add(g.facet);
            const first = glyphs.find((x) => x.facet === g.facet);
            if (!first) {
                glyphs.push({ facet: g.facet, shape: g.shape, role: g.role, ...(g.tone ? { tone: g.tone } : {}) });
                glyphDoc.set(g.facet, name);
            } else if (first.shape !== g.shape || first.role !== g.role || first.tone !== g.tone)
                (strict ? error : warning)(name, undefined, `glyph of facet "${g.facet}" differs from the one in ${glyphDoc.get(g.facet)}${strict ? '' : ` (${glyphDoc.get(g.facet)}'s is used)`}`);
        }
    }

    // ---- edge styles (1.4): the same rule as glyphs, for relations ----
    const edgeStyles: EdgeStyle[] = [];
    const styleDoc = new Map<string, string>();
    for (const { name, doc } of entries) {
        const here = new Set<string>();
        for (const st of doc.edgeStyles ?? []) {
            if (here.has(st.facet)) {
                error(name, undefined, `facet "${st.facet}" declared twice in edgeStyles`);
                continue;
            }
            here.add(st.facet);
            const first = edgeStyles.find((x) => x.facet === st.facet);
            if (!first) {
                edgeStyles.push({ facet: st.facet, dash: st.dash, role: st.role, ...(st.planned ? { planned: true } : {}) });
                styleDoc.set(st.facet, name);
            } else if (first.dash !== st.dash || first.role !== st.role || !!first.planned !== !!st.planned)
                (strict ? error : warning)(name, undefined, `edge style of facet "${st.facet}" differs from the one in ${styleDoc.get(st.facet)}${strict ? '' : ` (${styleDoc.get(st.facet)}'s is used)`}`);
        }
    }

    // ---- scope: own document + direct `requires` ----
    const scopeOf = new Map<string, Set<string>>();
    for (const { name, doc } of entries) {
        const scope = new Set([name]);
        for (const req of doc.requires ?? []) {
            if (!loaded.has(req)) dangling(name, undefined, `requires "${req}", which is not loaded`);
            scope.add(req);
        }
        scopeOf.set(name, scope);
    }
    // Returns true when `id` may be referenced from document `name`; records the problem otherwise.
    const reachable = (name: string, id: ElementId, what: string, at: string): boolean => {
        if (!byId.has(id)) {
            dangling(name, at, `${what} "${id}" does not exist`);
            return false;
        }
        const target = docOf.get(id)!;
        if (!scopeOf.get(name)!.has(target)) {
            error(name, at, `${what} "${id}" is in ${target}, which is not in "requires"`);
            return false;
        }
        return true;
    };

    for (const el of elements) {
        const name = docOf.get(el.id)!;
        if (el.parent != null && !reachable(name, el.parent, 'parent', el.id)) el.parent = null;
    }

    const edges: Edge[] = [];
    const edgeDocOf = new Map<EdgeId, string>();
    for (const { name, doc } of entries) {
        const seenHere = new Map<EdgeId, number>();
        for (const e of doc.edges ?? []) {
            const n = (seenHere.get(e.id) ?? 0) + 1;
            seenHere.set(e.id, n);
            if (edgeById.has(e.id)) {
                const other = edgeDocOf.get(e.id);
                error(name, e.id, other === name ? 'duplicate edge id' : `duplicate edge id (also in ${other})`, other === name ? n : 1);
                continue;
            }
            const okFrom = reachable(name, e.from, 'edge source', e.id);
            const okTo = reachable(name, e.to, 'edge target', e.id);
            const okVia = (e.via ?? []).every((v) => reachable(name, v, 'edge route (via)', e.id));
            const copy = { ...e };
            edgeById.set(e.id, copy);
            edgeDocOf.set(e.id, name);
            if (okFrom && okTo && okVia) edges.push(copy);
        }
    }

    // ---- claims (AD-8) ----
    const systems = elements.filter((el) => el.type === 'system');
    if (systems.length) {
        const claimedBy = new Map<ElementId, ElementId>();
        for (const sys of systems) {
            const name = docOf.get(sys.id)!;
            const kept: ElementId[] = [];
            for (const id of sys.contains ?? []) {
                if (!reachable(name, id, 'contains', sys.id)) continue;
                const target = byId.get(id)!; // reachable() checked it exists
                if (!CLAIMABLE.has(target.type)) {
                    error(name, sys.id, `contains "${id}" of type ${target.type}; only app and datastore can be claimed`);
                    continue;
                }
                if (claimedBy.has(id)) {
                    error(name, sys.id, `"${id}" is already claimed by ${claimedBy.get(id)}`);
                    continue;
                }
                claimedBy.set(id, sys.id);
                target.parent = sys.id;
                kept.push(id);
            }
            sys.contains = kept;
        }
        for (const el of elements) {
            if (CLAIMABLE.has(el.type) && !claimedBy.has(el.id)) {
                (strict ? error : warning)(docOf.get(el.id)!, el.id, `${el.type} is not claimed by any system`);
            }
        }
    }

    // ---- the hierarchy is a forest: a parent cycle is always an error, and it is cut so no traversal recurses forever ----
    const settled = new Set<ElementId>();
    for (const start of elements) {
        const path: ElementId[] = [];
        const onPath = new Set<ElementId>();
        let id: ElementId | null = start.id;
        while (id != null && !settled.has(id) && !onPath.has(id)) {
            path.push(id);
            onPath.add(id);
            id = byId.get(id)?.parent ?? null;
        }
        if (id != null && onPath.has(id)) {
            const cycle = path.slice(path.indexOf(id));
            const el = byId.get(id)!;
            error(docOf.get(id)!, id, `parent cycle: ${[...cycle, id].join(' → ')}`);
            el.parent = null;
        }
        for (const p of path) settled.add(p);
    }

    // ---- client layer: overrides, scenarios, envelopes (resolution of scenarios is core/resolve.js) ----
    const scenarios: MergedScenario[] = [];
    const scenarioIds = new Set<string>();
    const envelopes: Record<string, unknown> = {};
    const envelopeDoc = new Map<string, string>();
    for (const { name, doc } of entries) {
        for (const [id, o] of Object.entries(doc.overrides ?? {})) {
            if (!byId.has(id)) {
                dangling(name, id, 'override of an element that does not exist');
                continue;
            }
            if (docOf.get(id) === name) {
                error(name, id, 'override of an element of the same document; edit the element instead');
                continue;
            }
            Object.assign(byId.get(id)!, o);
        }
        for (const s of doc.scenarios ?? []) {
            if (scenarioIds.has(s.id)) {
                error(name, s.id, 'duplicate scenario id');
                continue;
            }
            scenarioIds.add(s.id);
            scenarios.push({ ...s, doc: name });
        }
        for (const [key, env] of Object.entries(doc.envelopes ?? {})) {
            if (envelopeDoc.has(key)) {
                error(name, key, `duplicate envelope (also in ${envelopeDoc.get(key)})`);
                continue;
            }
            envelopeDoc.set(key, name);
            envelopes[key] = env;
        }
    }

    return { elements, edges, scenarios, envelopes, tiers, glyphs, edgeStyles, byId, edgeById, docOf, edgeDocOf, errors, warnings };
}
