// `buildSpec`, the frontends: each app with its areas and files as elements, REST edges to the backend, imports.
import type { FrontendElements } from '../../../types/stacks/nest.ts';
import { addEdge, addEl, clean, cmp, contractOf, type BuildCtx } from './to-spec-ctx.ts';
import { routeEndpoint } from './to-spec-api.ts';

function addFrontendElements(c: BuildCtx, f: FrontendElements, appId: string): void {
    const { fe, areas } = f;
    addEl(c, { id: appId, type: 'app', tier: 'ui', parent: null, name: fe.title, description: fe.description, technology: fe.technology, provenance: 'extracted', source: { repo: fe.id, file: 'package.json', line: 1 }, facets: { 'vue.app': {} } });
    for (const [area, items] of areas) {
        const areaId = items[0].fqn.split('.').slice(0, 3).join('.');
        const first = [...items].map((i) => i.rel).sort(cmp)[0];
        addEl(c, {
            id: areaId,
            type: 'module',
            parent: appId,
            name: area,
            provenance: 'extracted',
            source: { repo: fe.id, file: first, line: 1 },
            derivedFrom: { rule: 'folder', value: area },
            confidence: 'high',
        });
        for (const it of items) {
            const facet = it.role === 'api' ? 'ts.api-client' : it.role === 'view' ? 'vue.view' : 'ts.module';
            addEl(c, { id: it.fqn, type: 'component', parent: areaId, name: it.rel.split('/').pop(), provenance: 'extracted', source: { repo: fe.id, file: it.rel, line: 1 }, facets: { [facet]: {} } });
        }
    }
}

/** REST calls: to the endpoint of a scope controller, or to a context controller (with its routes in the label). */
function addFrontendCalls(c: BuildCtx, f: FrontendElements): void {
    const { fe, files, elementOf } = f;
    for (const [rel, info] of files) {
        const from = elementOf(rel).fqn;
        for (const call of info.calls) {
            const r = call.route;
            const scope = !call.context;
            const e = addEdge(c, {
                from,
                to: scope ? routeEndpoint(c, r.controller, r.handler) : c.x.contextFqn(r.controller),
                channel: 'rest',
                label: `${r.method} /${r.path}`,
                site: { repo: fe.id, file: call.rel, line: call.line },
                contract: scope ? undefined : contractOf(c, r.operationId) ? clean(contractOf(c, r.operationId)!) : undefined,
            });
            if (e && !scope) (e.routes ??= new Set()).add(`${r.method} /${r.path}`);
        }
    }
}

function addFrontendImports(c: BuildCtx, f: FrontendElements): void {
    const { fe, users, importLines, elementOf } = f;
    for (const [rel, targets] of users) {
        const from = elementOf(rel).fqn;
        for (const t of targets) {
            const to = elementOf(t).fqn;
            if (from !== to) addEdge(c, { from, to, channel: 'import', site: { repo: fe.id, file: rel, line: importLines.get(`${rel}|${t}`) ?? 1 } });
        }
    }
}

export function addFrontends(c: BuildCtx): void {
    for (const f of c.x.feElements) {
        addFrontendElements(c, f, `${c.x.config.ID}.${f.fe.id}`);
        addFrontendCalls(c, f);
        addFrontendImports(c, f);
    }
}
