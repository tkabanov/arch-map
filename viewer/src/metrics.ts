// Pure metric computation and coloring, shared by the browser view and unit tests.
import { ancestors, countEndpoints, holdsLogic, inside } from './model.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { Model, PlacedNode, ViewNode } from '../../types/viewer.ts';

export function metric(model: Model, n: ViewNode, kind: string): number {
    if (kind === 'api') return countEndpoints(n);
    let c = 0;
    for (const e of model.edges) {
        if (e.kind === 'import' || e.kind === 'references') continue;
        const a = inside(model, e.from, n.id), b = inside(model, e.to, n.id);
        if (kind === 'db' ? a && model.nodes.get(e.to)?.type === 'table' : a !== b) c++;
    }
    return c;
}

/** Service blocks and executable logic inside datastores participate in metric coloring. */
function metricNode(model: Model, n: ViewNode): boolean {
    if (n.layer === 'service') return true;
    if (n.layer !== 'data' || (n.type !== 'component' && !(n.type === 'module' && holdsLogic(n)))) return false;
    return ancestors(model, n.id).some((a) => a.type === 'datastore');
}

export function metricTints(model: Model, placed: PlacedNode[], kind: string): Map<ElementId, number> | null {
    if (kind === 'kind') return null;
    const vals = new Map<ElementId, number>();
    for (const n of placed) if (!n._plate && metricNode(model, n)) vals.set(n.id, metric(model, n, kind));
    const max = Math.max(1, ...vals.values());
    return new Map([...vals].map(([id, v]) => [id, Math.sqrt(v / max)]));
}
