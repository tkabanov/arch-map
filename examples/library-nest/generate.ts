import { scanBackend, scanFrontend, matchRoute, buildSpec, ident } from 'arch-map/stacks/nest';
import { mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as config from './config.ts';
import { writeSpec } from 'arch-map/generator';
import { writeReport, targetHash } from './helpers.ts';
import type { ClassInfo, FrontendElements, NestAnalysis, RoutedCall } from 'arch-map/types/stacks/nest';

const home = fileURLToPath(new URL('.', import.meta.url));
const root = join(home, 'target');
const out = join(home, 'specs');
const be = scanBackend(ts, join(root, config.BACKEND.dir));
const fqn = new Map<ClassInfo, string>();
const owner = new Map<ClassInfo, ClassInfo>();
const apiFolders: NestAnalysis['apiFolders'] = new Map();
for (const mod of be.classes.values()) {
    if (mod.kind !== 'module') continue;
    const folder = mod.rel.split('/')[2];
    if (!config.BACKEND_SCOPE.includes(folder)) continue;
    const id = `library.api.${ident(folder)}.${ident(mod.name)}`;
    fqn.set(mod, id);
    const components: ClassInfo[] = [];
    for (const ref of [...mod.module!.providers, ...mod.module!.controllers]) {
        const cls = be.find(ref.name, ref.file);
        if (!cls) continue;
        fqn.set(cls, `${id}.${ident(cls.name)}`);
        owner.set(cls, mod);
        components.push(cls);
    }
    if (!apiFolders.has(folder)) apiFolders.set(folder, new Map());
    apiFolders.get(folder)!.set(mod, components);
}
const tables: NestAnalysis['tables'] = new Map();
const tableFqn = (model: ClassInfo): string => {
    const id = `library.db.${ident(model.tableName)}`;
    tables.set(model, { fqn: id, context: false });
    return id;
};
for (const cls of be.classes.values()) if (cls.kind === 'model') tableFqn(cls);
const fkRels: NestAnalysis['fkRels'] = [];
for (const [model, value] of tables) for (const fk of model.fks) {
    const target = be.find(fk.target, fk.targetFile);
    if (target?.kind === 'model') fkRels.push({ from: value.fqn, to: tableFqn(target), field: fk.field, rel: fk.rel, target: target.tableName, site: { repo: 'api', file: model.rel, line: fk.line } });
}
const routes = [...fqn.keys()].flatMap((controller) => controller.routes.map((route) => ({ ...route, controller })));
function frontend(): FrontendElements {
    const fe = config.FRONTENDS[0];
    const scan = scanFrontend(ts, fe, join(root, fe.dir));
    const files = new Map<string, { calls: RoutedCall[] }>();
    for (const call of scan.calls) {
        const route = matchRoute(routes, call);
        if (!route) continue;
        if (!files.has(call.rel)) files.set(call.rel, { calls: [] });
        files.get(call.rel)!.calls.push({ ...call, route });
    }
    const users = new Map<string, Set<string>>();
    for (const rel of files.keys()) for (const importer of scan.importers.get(rel) ?? []) users.set(importer, new Set([...(users.get(importer) ?? []), rel]));
    const elementOf = (rel: string) => ({ area: 'src/catalog', fqn: `library.web.catalog.${ident(rel.split('/').pop()?.replace(/\.(ts|vue)$/, ''))}` });
    const items = [...files.keys()].map((rel) => ({ rel, fqn: elementOf(rel).fqn, role: 'api' as const }));
    const views = [...users.keys()].map((rel) => ({ rel, fqn: elementOf(rel).fqn, role: 'view' as const }));
    return { fe, areas: new Map([['src/catalog', [...items, ...views]]]), sha: targetHash(root), files, users, importLines: scan.importLines, elementOf };
}
const result = buildSpec({ config, be, fqn, owner, targetOf: (cls) => fqn.get(cls) ?? null, contextFqn: () => null, tableFqn, tables, kindOf: (cls) => cls.kind === 'controller' ? 'controller' : 'service', apiFolders, contextModules: new Map(), scopeComponents: [...fqn.keys()].filter((cls) => cls.kind !== 'module'), feElements: [frontend()], relations: new Map(), fkRels, unmatched: [], commits: { api: targetHash(root), web: targetHash(root) }, openapi: JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')) });
mkdirSync(join(out, 'contracts'), { recursive: true });
copyFileSync(join(root, 'openapi.json'), join(out, config.CONTRACT_DOC));
writeSpec(join(out, 'library-nest.json'), result.doc);
writeReport(out, 'library-nest', result);
