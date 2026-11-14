// `buildSpec`, element passes of the backend side: the app, the event buses, the module / component / endpoint tree,
// then (after every edge exists) the database, the tables, the externals that are used and the context modules.
import type { BackendRoute, ClassInfo } from '../../../types/stacks/nest.ts';
import { accessOf, addEl, cfgSource, clean, cmp, contractOf, ident, validMethod, type BuildCtx } from './to-spec-ctx.ts';

export function addBackendRoot(c: BuildCtx): void {
    const { BACKEND } = c.x.config;
    addEl(c, {
        id: c.apiId,
        type: 'app',
        tier: 'service',
        parent: null,
        name: BACKEND.title,
        description: BACKEND.description,
        technology: BACKEND.technology,
        provenance: 'extracted',
        source: { repo: c.API, file: 'package.json', line: 1 },
        facets: { 'nest.app': {} },
    });
}

export const decoratorBusId = (c: BuildCtx, decorator: string): string => `${c.apiId}.bus.${ident(decorator)}`;

// ---------- buses: the event mechanisms, rails across the backend's column ----------
// DomainEvents (publish(new XEvent()) → @OnDomainEvent handlers) and each decorator dispatcher of EVENT_DECORATORS.
// Their event edges go through them: publisher#method → bus#<topic>, bus#<topic> → handler#method; the topic (the
// event class, or the decorator) stands where a method would, so a Path walks on to the subscribers of that topic.
export function addBuses(c: BuildCtx): void {
    const { be, fqn, config } = c.x;
    const { DOMAIN_EVENTS, EVENT_DECORATORS } = config;
    const busClass = be.byName.get(DOMAIN_EVENTS.bus)?.[0];
    addEl(c, {
        id: c.domainBusId,
        type: 'bus',
        parent: c.apiId,
        name: DOMAIN_EVENTS.bus,
        description: `In-process domain events: \`publish(new XEvent())\` reaches every \`@${DOMAIN_EVENTS.decorator}\` handler of that event.`,
        technology: DOMAIN_EVENTS.technology,
        ...(busClass ? { provenance: 'extracted', source: { repo: c.API, file: busClass.rel, line: busClass.line } } : { provenance: 'declared', source: cfgSource(c, 'DOMAIN_EVENTS') }),
    });
    c.buses.set(c.domainBusId, { edges: 0 });
    for (const [decorator, ev] of Object.entries(EVENT_DECORATORS)) {
        const dispatcher = be.byName.get(ev.dispatcher)?.[0];
        if (!dispatcher || !fqn.has(dispatcher)) continue;
        addEl(c, {
            id: decoratorBusId(c, decorator),
            type: 'bus',
            parent: c.apiId,
            name: `@${decorator}`,
            description: `${ev.dispatcher} runs every \`@${decorator}\` handler: ${ev.title}.`,
            technology: ev.technology,
            provenance: 'declared',
            source: cfgSource(c, `EVENT_DECORATORS.${decorator}`),
        });
        c.buses.set(decoratorBusId(c, decorator), { edges: 0 });
    }
}

// ---------- the tree: folders → modules → components → endpoints ----------

function endpointId(c: BuildCtx, cls: ClassInfo, r: BackendRoute): string {
    const base = `${c.x.fqn.get(cls)}.${r.method.toLowerCase()}_${r.path ? ident(r.path) : 'root'}`;
    const id = c.usedEndpointIds.has(base) ? `${base}_${ident(r.handler)}` : base;
    c.usedEndpointIds.add(id);
    return id;
}

function addEndpoint(c: BuildCtx, cls: ClassInfo, r: BackendRoute): void {
    const id = endpointId(c, cls, r);
    c.endpointIds.set(r, id);
    addEl(c, {
        id,
        type: 'endpoint',
        parent: c.x.fqn.get(cls),
        name: `${r.method} /${r.path}`,
        description: r.doc,
        provenance: 'extracted',
        source: { repo: c.API, file: cls.rel, line: r.line },
        handler: validMethod(r.handler),
        http: { method: r.method, path: `/${r.path}` },
        access: accessOf(r),
        contract: contractOf(c, r.operationId) ? clean(contractOf(c, r.operationId)!) : undefined,
        facets: { 'nest.route': clean({ auth: r.auth, system: r.system || undefined, body: r.body ?? undefined }) },
    });
}

function addComponent(c: BuildCtx, cls: ClassInfo, modId: string): void {
    const kind = c.x.kindOf(cls);
    addEl(c, {
        id: c.x.fqn.get(cls)!,
        type: 'component',
        parent: modId,
        name: cls.name,
        description: cls.doc,
        provenance: 'extracted',
        source: { repo: c.API, file: cls.rel, line: cls.line },
        facets: {
            [`nest.${kind}`]: clean({ prefix: kind === 'controller' ? `/${cls.prefix}` : undefined, model: cls.baseModel?.name }),
        },
    });
    for (const r of cls.routes) addEndpoint(c, cls, r);
}

export function addApiTree(c: BuildCtx): void {
    for (const [folder, mods] of c.x.apiFolders) {
        const folderId = `${c.apiId}.${ident(folder.split('/').pop())}`;
        const first = [...mods.keys()].sort((a, b) => cmp(a.rel, b.rel))[0];
        addEl(c, {
            id: folderId,
            type: 'module',
            parent: c.apiId,
            name: folder,
            description: `Folder src/modules/${folder}.`,
            provenance: 'extracted',
            source: { repo: c.API, file: first.rel, line: first.line },
            derivedFrom: { rule: 'folder', value: `src/modules/${folder}` },
            confidence: 'high',
        });
        for (const [mod, comps] of mods) {
            const modId = c.x.fqn.get(mod)!; // the slice's modules and components all have an id
            addEl(c, { id: modId, type: 'module', parent: folderId, name: mod.name, description: mod.doc, provenance: 'extracted', source: { repo: c.API, file: mod.rel, line: mod.line }, facets: { 'nest.module': {} } });
            for (const cls of comps) addComponent(c, cls, modId);
        }
    }
}

export function routeEndpoint(c: BuildCtx, controller: ClassInfo, handler: string): string | undefined {
    const r = controller.routes.find((x) => x.handler === handler);
    return r ? c.endpointIds.get(r) : undefined;
}

// ---------- data and externals ----------

export function addDataElements(c: BuildCtx): void {
    const { tables, config } = c.x;
    const { DATABASE, EXTERNALS } = config;
    addEl(c, { id: DATABASE.id, type: 'datastore', parent: null, name: DATABASE.title, description: DATABASE.description, technology: DATABASE.technology, provenance: 'declared', source: cfgSource(c, 'DATABASE'), facets: { 'mysql.database': {} } });
    for (const [model, t] of tables)
        addEl(c, {
            id: t.fqn,
            type: 'table',
            parent: DATABASE.id,
            name: model.tableName,
            description: model.doc,
            technology: `Sequelize ${model.name}`,
            provenance: 'extracted',
            context: t.context || undefined,
            source: { repo: c.API, file: model.rel, line: model.line },
            columns: model.columns.map((col) => ({ name: col.name, type: col.type, nullable: col.nullable, pk: col.pk })),
            facets: { 'sequelize.model': { model: model.name, associations: model.fks.map((f) => clean({ rel: f.rel, field: f.field, target: f.target, through: f.through ?? undefined })) } },
        });
    const used = new Set([...c.edges.values()].flatMap((e) => [e.from, e.to]));
    for (const [id, e] of Object.entries(EXTERNALS))
        if (used.has(id)) addEl(c, { id, type: 'external-system', parent: null, name: e.title, description: e.description, technology: e.technology, provenance: 'declared', source: cfgSource(c, `EXTERNALS.${id}`), facets: { 'config.external': {} } });
}

/** context modules (outside the slice) — after every edge, since edges create them */
export function addContextModules(c: BuildCtx): void {
    for (const [mod, id] of c.x.contextModules)
        addEl(c, { id, type: 'module', parent: c.apiId, name: mod.name, description: mod.doc, context: true, provenance: 'extracted', source: { repo: c.API, file: mod.rel, line: mod.line }, facets: { 'nest.module': {} } });
}
