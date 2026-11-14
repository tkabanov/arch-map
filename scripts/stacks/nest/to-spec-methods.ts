// `buildSpec`, edge passes of the backend side: the per-method edges of the scope components (calls, data access,
// events, self calls, dispatchers), the inherited repository methods, external-client classes, inbound channels,
// foreign keys, and the class-level edges for relations no method explains; finally the methods listed on elements.
import type { Site } from '../../../types/spec.d.ts';
import type { BackendDep, ClassInfo, EventHandler, MethodFacts, Relation } from '../../../types/stacks/nest.ts';
import { addEdge, bySite, clean, cmp, validMethod, type BuildCtx, type MethodEntry } from './to-spec-ctx.ts';
import { decoratorBusId } from './to-spec-api.ts';

// ---------- per-method edges of scope components ----------

function methodEntry(c: BuildCtx, cls: ClassInfo, name: string): MethodEntry {
    if (!c.methodsOf.has(cls)) c.methodsOf.set(cls, new Map());
    const map = c.methodsOf.get(cls)!;
    if (!map.has(name)) map.set(name, { name, line: cls.memberLines.get(name), unresolved: [] });
    return map.get(name)!;
}

export function addMethodEntries(c: BuildCtx): void {
    for (const cls of c.x.scopeComponents) {
        for (const name of cls.memberLines.keys()) if (validMethod(name)) methodEntry(c, cls, name);
        for (const name of cls.methods.keys()) if (validMethod(name)) methodEntry(c, cls, name);
    }
}

const baseOf = (c: BuildCtx, cls: ClassInfo): ClassInfo | null => (cls.baseModel && cls.base ? c.x.be.find(cls.base.name, cls.base.file) : null);
const isInherited = (c: BuildCtx, cls: ClassInfo, m: string): boolean => !!baseOf(c, cls)?.memberLines.has(m) && !cls.memberLines.has(m);
function useInherited(c: BuildCtx, cls: ClassInfo, m: string): void {
    if (!c.x.fqn.has(cls) || !isInherited(c, cls, m)) return;
    if (!c.inherited.has(cls)) c.inherited.set(cls, new Set());
    c.inherited.get(cls)!.add(m);
}

/** A data-access edge: one operation on a model's table, from a (class, method). */
interface DataAccess {
    from: string | undefined;
    fromMethod: string | undefined;
    model: ClassInfo;
    op: string;
    site: Site;
}
function dataEdge(c: BuildCtx, d: DataAccess): void {
    addEdge(c, { from: d.from, fromMethod: d.fromMethod, to: c.x.tableFqn(d.model, true), channel: c.x.config.READ_METHODS.has(d.op) ? 'read' : 'write', ops: [d.op], site: d.site });
}

function handlersOf(c: BuildCtx, pred: (hd: EventHandler) => boolean): [ClassInfo, EventHandler][] {
    const out: [ClassInfo, EventHandler][] = [];
    for (const h of c.x.be.classes.values()) for (const hd of h.eventHandlers) if (pred(hd)) out.push([h, hd]);
    return out;
}

/** One method of a scope component, with what its class gives every method. */
interface MethodScope {
    cls: ClassInfo;
    from: string | undefined;
    depBy: Map<string, BackendDep>;
    /** the method's name, and the same when it is a valid id segment */
    m: string;
    fm: string | undefined;
    info: MethodFacts;
}

const siteIn = (c: BuildCtx, ms: MethodScope, line: number): Site => ({ repo: c.API, file: ms.cls.rel, line });

/** `this.<param>.<method>()` where the dependency is not a known class: a package client, or an unresolved call. */
function unknownTarget(c: BuildCtx, ms: MethodScope, call: MethodFacts['calls'][number], d: BackendDep): void {
    const { cls, from, fm } = ms;
    if (d.typeFile?.startsWith('pkg:')) {
        const key = `${cls.rel}|${d.param}`;
        if (!c.packageClients.has(key))
            c.packageClients.set(key, { kind: 'package-client', repo: c.API, file: cls.rel, line: d.line, element: from, expr: `${d.param}: ${d.typeName} from ${d.typeFile.slice(4)}`, calls: new Set() });
        c.packageClients.get(key)!.calls.add(call.method);
    } else if (fm) methodEntry(c, cls, fm).unresolved.push({ expr: `this.${call.param}.${call.method}() — ${d.typeName ?? (d.token ? `@Inject(${d.token})` : 'untyped')} is not a known class`, line: call.line });
}

/** One `this.<param>.<method>()` call of a method: data access, an external client, or a call to another class. */
function callEdge(c: BuildCtx, ms: MethodScope, call: MethodFacts['calls'][number]): void {
    const { be, fqn, targetOf, config } = c.x;
    const { from, fm, depBy } = ms;
    const d = depBy.get(call.param);
    if (!d) return;
    if (d.model) {
        const model = be.find(d.model, d.modelFile);
        if (model?.kind === 'model') dataEdge(c, { from, fromMethod: fm, model, op: call.method, site: siteIn(c, ms, call.line) });
        return;
    }
    const target = d.typeName ? be.find(d.typeName, d.typeFile) : null;
    const ext = d.typeName ? config.EXTERNAL_CLIENTS[d.typeName] : undefined;
    if (ext && !(target && fqn.has(target))) {
        addEdge(c, {
            from,
            fromMethod: fm,
            to: ext.external,
            channel: ext.kind,
            label: ext.title,
            ops: [call.method],
            site: siteIn(c, ms, call.line),
            declared: `EXTERNAL_CLIENTS.${d.typeName}`,
            facets: { 'config.external': clean({ client: d.typeName, protocol: ext.protocol, technology: ext.technology }) },
        });
        return;
    }
    if (d.typeName === config.DOMAIN_EVENTS.bus) return; // publish(): event edges below
    if (!target) {
        unknownTarget(c, ms, call, d);
        return;
    }
    if (target.kind === 'model') return;
    const inScopeTarget = fqn.has(target) && target.kind !== 'module';
    if (inScopeTarget) useInherited(c, target, call.method);
    addEdge(c, {
        from,
        fromMethod: fm,
        to: targetOf(target),
        toMethod: inScopeTarget ? call.method : undefined,
        channel: 'call',
        site: siteIn(c, ms, call.line),
        facets: { 'nest.di': { param: call.param, type: target.name } },
    });
}

/** `this.model.<op>()` of a repository and `Model.<op>()` on imported models. */
function dataEdges(c: BuildCtx, ms: MethodScope): void {
    const { be } = c.x;
    const { cls, from, fm, info } = ms;
    const baseModel = cls.baseModel && be.find(cls.baseModel.name, cls.baseModel.file);
    if (baseModel?.kind === 'model') for (const op of info.model) dataEdge(c, { from, fromMethod: fm, model: baseModel, op: op.method, site: siteIn(c, ms, op.line) });
    for (const st of info.statics) {
        const model = be.find(st.name, cls.imports.get(st.name));
        if (model?.kind === 'model') dataEdge(c, { from, fromMethod: fm, model, op: st.method, site: siteIn(c, ms, st.line) });
    }
}

/** `publish(new XEvent())` → bus → every handler of the event. */
function publishEdges(c: BuildCtx, ms: MethodScope): void {
    const { be, fqn, targetOf, config } = c.x;
    const { DOMAIN_EVENTS } = config;
    const { from, fm, info } = ms;
    for (const p of info.publishes)
        for (const [h, hd] of handlersOf(c, (x) => x.decorator === DOMAIN_EVENTS.decorator && x.argFile === p.file)) {
            const name = be.constants.get(`${hd.argFile}#${hd.argName}`) ?? p.name;
            const facets = { 'nest.event': { event: p.name, name, decorator: DOMAIN_EVENTS.decorator } };
            addEdge(c, { from, fromMethod: fm, to: c.domainBusId, toMethod: p.name, channel: 'event', label: name, site: siteIn(c, ms, p.line), facets });
            addEdge(c, {
                from: c.domainBusId,
                fromMethod: p.name,
                to: targetOf(h),
                toMethod: fqn.has(h) ? hd.method : undefined,
                channel: 'event',
                label: name,
                site: { repo: c.API, file: h.rel, line: hd.line },
                facets: { 'nest.event': { ...facets['nest.event'], handler: `${h.name}.${hd.method}` } },
            });
            c.viaBus.add(`${from}|${targetOf(h)}|event`);
        }
}

/** `this.ownMethod()` */
function selfEdges(c: BuildCtx, ms: MethodScope): void {
    const { cls, from, fm, m, info } = ms;
    for (const s of info.self) {
        if (s.method === m) continue; // plain recursion adds nothing to a Path
        if (!cls.memberLines.has(s.method) && !cls.methods.has(s.method) && !isInherited(c, cls, s.method)) continue;
        useInherited(c, cls, s.method);
        addEdge(c, { from, fromMethod: fm, to: from, toMethod: s.method, channel: 'call', site: siteIn(c, ms, s.line) });
    }
}

/** a dispatcher method runs every subscriber of its decorator (config rule → declared) */
function dispatcherEdges(c: BuildCtx, ms: MethodScope): void {
    const { fqn, targetOf, config } = c.x;
    const { cls, from, fm, m } = ms;
    for (const [decorator, ev] of Object.entries(config.EVENT_DECORATORS)) {
        if (cls.name !== ev.dispatcher || !ev.dispatchMethod.test(m)) continue;
        const bus = decoratorBusId(c, decorator);
        const handlers = handlersOf(c, (hd) => hd.decorator === decorator);
        if (!handlers.length) continue;
        // the dispatcher method runs the subscribers (config rule → declared); who subscribes is in code
        addEdge(c, {
            from,
            fromMethod: fm,
            to: bus,
            toMethod: decorator,
            channel: 'event',
            label: ev.title,
            site: siteIn(c, ms, cls.memberLines.get(m) ?? cls.line),
            declared: `EVENT_DECORATORS.${decorator}`,
            facets: { 'nest.event': { decorator } },
        });
        for (const [h, hd] of handlers) {
            addEdge(c, {
                from: bus,
                fromMethod: decorator,
                to: targetOf(h),
                toMethod: fqn.has(h) ? hd.method : undefined,
                channel: 'event',
                label: ev.title,
                site: { repo: c.API, file: h.rel, line: hd.line },
                facets: { 'nest.event': { decorator, handler: `${h.name}.${hd.method}` } },
            });
            c.viaBus.add(`${from}|${targetOf(h)}|event`);
        }
    }
}

export function addMethodEdges(c: BuildCtx): void {
    for (const cls of c.x.scopeComponents) {
        const from = c.x.fqn.get(cls);
        const depBy = new Map(cls.deps.map((d) => [d.param, d]));
        for (const [m, info] of cls.methods) {
            const ms: MethodScope = { cls, from, depBy, m, fm: validMethod(m), info };
            for (const call of info.calls) callEdge(c, ms, call);
            dataEdges(c, ms);
            publishEdges(c, ms);
            selfEdges(c, ms);
            dispatcherEdges(c, ms);
            if (ms.fm) for (const u of info.unresolved) methodEntry(c, cls, ms.fm).unresolved.push(u);
        }
    }
}

// ---------- the rest of the edges ----------

/** inherited base-repository methods used by someone: methods of the repository, with the data access they wrap */
export function addInheritedMethods(c: BuildCtx): void {
    const { be, fqn } = c.x;
    for (const [cls, names] of c.inherited) {
        const base = baseOf(c, cls);
        // only repositories (a baseModel and a base class) inherit
        const model = be.find(cls.baseModel!.name, cls.baseModel!.file);
        for (const name of names) {
            methodEntry(c, cls, name).line = undefined; // declared in the base class, not in this file
            if (model?.kind !== 'model') continue;
            for (const op of base!.methods.get(name)?.model ?? []) dataEdge(c, { from: fqn.get(cls), fromMethod: name, model, op: op.method, site: { repo: c.API, file: base!.rel, line: op.line } });
        }
    }
}

/** a class that is itself an external client (config rule) */
export function addExternalClientClasses(c: BuildCtx): void {
    const { fqn, scopeComponents, config } = c.x;
    for (const cls of scopeComponents) {
        const ext = config.EXTERNAL_CLIENTS[cls.name];
        if (!ext) continue;
        addEdge(c, {
            from: fqn.get(cls),
            to: ext.external,
            channel: ext.kind,
            label: ext.title,
            site: { repo: c.API, file: cls.rel, line: cls.line },
            declared: `EXTERNAL_CLIENTS.${cls.name}`,
            facets: { 'config.external': clean({ client: cls.name, protocol: ext.protocol, technology: ext.technology }) },
        });
    }
}

/** inbound channels from outside (config rule → declared), to the endpoint they call */
export function addInboundEdges(c: BuildCtx): void {
    const { be, fqn, config } = c.x;
    for (const inb of config.INBOUND) {
        const ctl = be.byName.get(inb.controller)?.[0];
        if (!ctl || !fqn.has(ctl)) continue;
        const route = ctl.routes.find((r) => r.handler === inb.method);
        addEdge(c, {
            from: inb.from,
            to: route ? c.endpointIds.get(route) : fqn.get(ctl),
            channel: inb.kind,
            label: inb.title,
            site: { repo: c.API, file: ctl.rel, line: route?.line ?? ctl.line },
            declared: `INBOUND.${inb.from}.${inb.method}`,
        });
    }
}

/** FK between tables: one `references` edge per table pair, field names in ops */
export function addForeignKeyEdges(c: BuildCtx): void {
    const { fkRels } = c.x;
    for (const fk of fkRels)
        addEdge(c, { from: fk.from, to: fk.to, channel: 'references', ops: [fk.field], site: fk.site, facets: { 'sequelize.fk': {} } });
    for (const fk of fkRels) {
        const e = c.edges.get(`${fk.from}>${fk.to}:references`)!;
        const list = (e.fkList ??= []);
        if (!list.some((f) => f.field === fk.field && f.rel === fk.rel)) list.push({ field: fk.field, rel: fk.rel });
    }
}

// ---------- class-level edges: relations no method explains ----------
// e.g. a dependency injected but never called, or a call made in a constructor. Same (from, to, kind) as the
// class-level relation, without fromMethod (AD-4 allows it), so no relation is lost.

function relationEdge(c: BuildCtx, r: Relation, site: Site): void {
    const { READ_METHODS } = c.x.config;
    if (r.kind === 'calls') addEdge(c, { from: r.from, to: r.to, channel: 'call', site, facets: r.via ? { 'nest.di': { param: r.via.param, type: r.via.type } } : undefined });
    else if (r.kind === 'sql') {
        const reads = r.ops.filter((op) => READ_METHODS.has(op));
        const writes = r.ops.filter((op) => !READ_METHODS.has(op));
        if (reads.length || !writes.length) addEdge(c, { from: r.from, to: r.to, channel: 'read', ops: reads, site });
        if (writes.length) addEdge(c, { from: r.from, to: r.to, channel: 'write', ops: writes, site });
    } else if (r.kind === 'event') addEdge(c, { from: r.from, to: r.to, channel: 'event', label: r.title, site });
    else throw new Error(`to-spec: relation ${r.from} -[${r.kind}]-> ${r.to} has no spec edge`);
}

/** Returns how many relations needed a class-level edge. */
export function addClassLevelEdges(c: BuildCtx): number {
    const ownerOf = new Map([...c.endpointIds.values()].map((id): [string, string | null] => [id, c.elements.get(id)!.parent]));
    const fold = (id: string): string => ownerOf.get(id) ?? id;
    const FAMILY: Record<string, string> = { call: 'calls', import: 'uses', references: 'fk', read: 'sql', write: 'sql' };
    const covered = new Set([...c.edges.values()].map((e) => `${fold(e.from)}|${fold(e.to)}|${FAMILY[e.channel] ?? e.channel}`));
    for (const k of c.viaBus) covered.add(k); // an event that goes through a bus covers its publisher → subscriber relation
    let classLevelEdges = 0;
    for (const r of c.x.relations.values()) {
        if (covered.has(`${r.from}|${r.to}|${r.kind}`)) continue;
        const site = [...r.sites].sort(bySite)[0];
        classLevelEdges++;
        relationEdge(c, r, site);
    }
    return classLevelEdges;
}

// ---------- methods of scope components ----------

export function attachMethods(c: BuildCtx): void {
    const { fqn } = c.x;
    for (const [cls, map] of c.methodsOf) {
        const el = c.elements.get(fqn.get(cls)!)!;
        el.methods = [...map.values()].map((m) => clean({ name: m.name, line: m.line, unresolved: m.unresolved.length ? [...new Map(m.unresolved.map((u) => [`${u.line}|${u.expr}`, u])).values()].sort((a, b) => a.line - b.line || cmp(a.expr, b.expr)) : undefined }));
        if (!el.methods.length) delete el.methods;
        for (const m of map.values()) for (const u of m.unresolved) c.unresolved.push({ kind: 'dynamic-call', repo: c.API, file: cls.rel, line: u.line, element: fqn.get(cls), method: m.name, expr: u.expr });
    }
}
