// The one place the viewer turns merged specs (core/merge.js) into its internal model (docs/architecture.md AD-12):
// nodes with a core `type`, a glyph `shape` and a `layer` (= core tier), endpoints folded into their component,
// edges with their core channel as `kind` and a legend `group`. `shapeOf()` here (with the documents' `glyphs`) and
// the panel's «Code details» are the only readers of facets (AD-12, AD-13), and neither names a facet key;
// `?nofacets=1` strips them here (browser boundary test).
import { tierOf } from './core/tier.ts';
import { effectiveAccess, effectiveContract } from './core/resolve.ts';
import type { Channel, Element, ElementId, Facets, Glyph, MethodName, Repo, Source } from '../../types/spec.d.ts';
import type { MergedSet, SpecEntry } from '../../types/core.ts';
import type { AdaptedNode, RawModel, ViewEdge } from '../../types/viewer.ts';

/** Major version of the spec format this viewer reads (AD-1). */
export const SCHEMA_MAJOR = '1';

/** Core channel → legend group (AD-12). */
export const GROUP_OF: Record<Channel, string> = {
    rest: 'rest',
    read: 'data',
    write: 'data',
    event: 'event',
    trigger: 'event',
    schedule: 'event',
    webhook: 'ext',
    https: 'ext',
    smtp: 'ext',
    call: 'call',
    import: 'import',
    references: 'references',
    interacts: 'interacts',
};

// core fallback: always defined, so an element without facets is never blank (AD-13)
const TYPE_SHAPE: Record<string, [string, string]> = {
    actor: ['person', 'actor'],
    system: ['matrix', 'system'],
    app: ['matrix', 'application'],
    module: ['matrix', 'module'],
    component: ['core', 'component'],
    endpoint: ['dot', 'endpoint'],
    datastore: ['matrix', 'data store'],
    table: ['grid', 'table'],
    'external-system': ['orbit', 'external system'],
    job: ['clock', 'job'],
    queue: ['stack', 'queue'],
    bus: ['rail', 'event bus'],
    group: ['matrix', 'group'],
};

/**
 * Glyph and role of an element: the first of the merged set's `glyphs` whose facet the element carries (declared by
 * the stack that emits the facet — the viewer names no facet), the core type as fallback (AD-13).
 */
export function shapeOf(el: Pick<Element, 'type' | 'facets' | 'derivedFrom'>, glyphs: readonly Glyph[] = []): { shape: string; role: string } {
    if (el.facets) for (const g of glyphs) if (el.facets[g.facet]) return { shape: g.shape, role: g.role };
    const [shape, role] = TYPE_SHAPE[el.type] ?? ['matrix', el.type];
    return { shape, role: el.type === 'module' && el.derivedFrom?.rule === 'folder' ? 'folder' : role };
}

/** A clickable code link: fills the document's `blob` template (AD-5); null for config sources. */
function sourceUrl(repos: Record<string, Repo>, source: Source | undefined): string | null {
    const code = source && 'repo' in source ? source : undefined; // a config source has no repo
    const repo: Repo | undefined = code?.repo ? repos[code.repo] : undefined;
    if (!repo?.blob || !code!.file) return null;
    const url = repo.blob.replace('{file}', code!.file).replace('{line}', String(code!.line ?? 1));
    return /^https?:\/\//.test(url) ? url : null; // a local file (a database snapshot) is shown as text, not a link
}

const siteText = (s: { file: string; line: number }): string => `${s.file}:${s.line}`;

/**
 * Merged specs → the raw model `buildModel()` consumes:
 * { meta, nodes[], edges[], merged, nodeOf(id), endpointOwner }.
 * `docs` are the loaded documents in load order ({ name, doc }) — for titles and repos.
 */
export function adaptSpecs(merged: MergedSet, docs: SpecEntry[], { nofacets = false }: { nofacets?: boolean } = {}): RawModel {
    const facetsOf = (x: { facets?: Facets }): Facets | undefined => (nofacets ? undefined : x.facets);
    const repos: Record<string, Repo> = {};
    for (const { doc } of docs) Object.assign(repos, doc.repos ?? {});

    // ---- endpoints fold into their component (the single rule) ----
    const endpointOwner = new Map<ElementId, ElementId>();
    for (const el of merged.elements) if (el.type === 'endpoint' && el.parent) endpointOwner.set(el.id, el.parent);
    const nodeOf = (id: ElementId): ElementId => endpointOwner.get(id) ?? id;

    const nodes: AdaptedNode[] = [];
    const byId = new Map<ElementId, AdaptedNode>();
    for (const el of merged.elements) {
        if (el.type === 'endpoint') continue;
        const facets = facetsOf(el);
        const { shape, role } = shapeOf({ ...el, facets }, merged.glyphs);
        const n: AdaptedNode = {
            id: el.id,
            parent: el.parent ?? null,
            type: el.type,
            shape,
            role,
            layer: tierOf(merged, el.id),
            title: el.name,
            description: el.description,
            technology: el.technology,
            context: !!el.context,
            provenance: el.provenance,
            source: el.source,
            sourceUrl: sourceUrl(repos, el.source),
            file: el.source && 'file' in el.source ? el.source.file : undefined,
            endpoints: [],
            methods: el.methods ? el.methods.map((m) => m.name) : null,
            columns: el.columns,
            facets,
            derivedFrom: el.derivedFrom,
            confidence: el.confidence,
            deps: [],
        };
        nodes.push(n);
        byId.set(n.id, n);
    }
    for (const el of merged.elements) {
        if (el.type !== 'endpoint') continue;
        const owner = byId.get(nodeOf(el.id));
        if (!owner) continue;
        owner.endpoints.push({
            id: el.id,
            method: el.http?.method ?? '',
            path: el.http?.path ?? el.name,
            title: el.name,
            access: el.access ?? null,
            contract: el.contract ?? null,
            handler: el.handler ?? null,
            sourceUrl: sourceUrl(repos, el.source),
        });
    }
    for (const n of nodes) n.endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

    // ---- edges: core channel as kind, endpoint folded, items for labels and the panel ----
    const edges: ViewEdge[] = [];
    const deps = new Map<ElementId, Map<ElementId, Set<MethodName>>>(); // component → target → Set(methods): the DI list, rebuilt from `call` edges
    for (const e of merged.edges) {
        const from = nodeOf(e.from);
        const to = nodeOf(e.to);
        if (from === to) continue; // calls of a component to its own methods: Path material, not a relation on the map
        const ep = endpointOwner.has(e.to) ? merged.byId.get(e.to) : null;
        let items: string[];
        if (e.channel === 'rest') {
            const route = ep?.http ? `${ep.http.method} ${ep.http.path}` : e.label ?? '';
            const sites = e.sites ?? (e.source && 'file' in e.source && e.source.file ? [e.source] : []);
            items = sites.length ? sites.map((s) => `${route} ← ${siteText(s)}`) : [route];
        } else if (e.ops?.length) items = [e.ops.join(', ')];
        else if (e.fromMethod || e.toMethod) items = [`${e.fromMethod ? `${e.fromMethod}()` : '·'} → ${e.toMethod ? `${e.toMethod}()` : merged.byId.get(e.to)?.name ?? e.to}`];
        else items = e.label ? [e.label] : [];
        const title = e.label ?? (e.channel === 'call' && e.toMethod ? `${e.toMethod}()` : e.channel === 'read' ? 'reads' : e.channel === 'write' ? 'writes' : '');
        edges.push({
            id: e.id,
            from,
            to,
            kind: e.channel,
            group: GROUP_OF[e.channel] ?? 'call',
            title,
            items,
            ops: e.ops ?? [],
            access: effectiveAccess(merged, e),
            contract: effectiveContract(merged, e),
            provenance: e.provenance,
            fromMethod: e.fromMethod,
            toMethod: e.toMethod,
            via: (e.via ?? []).map(nodeOf),
            ...(ep ? { endpoint: ep.id } : {}),
            facets: facetsOf(e),
        });
        if (e.channel === 'call') {
            const m = deps.get(from) ?? deps.set(from, new Map()).get(from)!;
            const s = m.get(to) ?? m.set(to, new Set()).get(to)!;
            if (e.toMethod) s.add(e.toMethod);
        }
    }
    for (const [id, targets] of deps) {
        const n = byId.get(id);
        if (!n) continue;
        n.deps = [...targets].map(([to, ms]) => ({ id: to, name: byId.get(to)?.title ?? to, methods: [...ms].sort() })).sort((a, b) => a.name.localeCompare(b.name));
    }

    const meta = {
        docs: docs.map(({ name, doc }) => ({ name, title: doc.title ?? name })),
        repos,
        counts: { elements: merged.elements.length, edges: merged.edges.length },
        nofacets,
    };
    return { meta, nodes, edges, merged, nodeOf, endpointOwner };
}
