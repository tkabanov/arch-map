// Generic spec-building helpers shared by every generator stack: id segments, code-unit comparison, and an element /
// edge collector with the generators' conventions. Pure; names no project.
import type { Edge, Element, ElementId } from '../../types/spec.d.ts';
import type { EdgeDraft, ElementDraft, SpecBuilder } from '../../types/generator.ts';

export const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
export const seg = (s: unknown): string => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/__+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/**
 * Elements and edges keyed by id. An element id taken twice by different types fails; empty fields are dropped
 * (`parent` stays). Edge id = `<from>[#m]><to>[#m]:<channel>`; the same edge again adds its ops and its site.
 */
export function specBuilder(): SpecBuilder {
    const elements = new Map<ElementId, Element>();
    const addEl = (el: ElementDraft): ElementId => {
        if (elements.has(el.id)) {
            const was = elements.get(el.id)!;
            if (was.type !== el.type) throw new Error(`id ${el.id} is taken: ${was.type} vs ${el.type}`);
            return el.id;
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(el)) if (k === 'parent' || (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))) out[k] = v;
        // a draft with the schema's fields: the document is validated before it is written (writeSpec)
        elements.set(el.id, out as unknown as Element);
        return el.id;
    };
    const edges = new Map<string, Edge>();
    // `ops` and `sites` are arrays from the first addEdge until finishEdges drops the empty ones
    const addEdge = (e: EdgeDraft): Edge => {
        const id = `${e.from}${e.fromMethod ? `#${e.fromMethod}` : ''}>${e.to}${e.toMethod ? `#${e.toMethod}` : ''}:${e.channel}`;
        const acc = edges.get(id);
        if (acc) {
            for (const op of e.ops ?? []) if (!acc.ops!.includes(op)) acc.ops!.push(op);
            const site = e.site;
            if (site && !acc.sites!.some((s) => s.file === site.file && s.line === site.line)) acc.sites!.push(site);
            return acc;
        }
        const draft: Record<string, unknown> = { id, provenance: e.provenance ?? 'extracted', ops: [], sites: [] };
        for (const [k, v] of Object.entries(e)) if (k !== 'site' && v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) draft[k] = v;
        const out = draft as unknown as Edge; // validated with the document (writeSpec)
        out.ops = [...(e.ops ?? [])];
        if (e.site) out.sites = [e.site];
        edges.set(id, out);
        return out;
    };
    /** ops only where the schema has them, sites only when more than one (sorted), none on declared edges */
    const finishEdges = () => {
        for (const e of edges.values()) {
            if (!e.ops!.length || !['read', 'write', 'references', 'https', 'smtp'].includes(e.channel)) delete e.ops;
            if (e.sites!.length < 2) delete e.sites;
            else e.sites!.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
            if (e.provenance === 'declared') delete e.sites;
        }
        return [...edges.values()];
    };
    return { elements, edges, addEl, addEdge, finishEdges };
}
