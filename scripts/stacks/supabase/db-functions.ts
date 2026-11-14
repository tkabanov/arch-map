// `buildSupabaseSpec`, the logic inside Postgres (a module of the datastore): functions grouped by domain, their components and RPC endpoints,
// what each body reads / writes / calls, triggers, and pg_cron as one rail with a topic per job.
import { analyzeFunction, analyzeSql } from './sql.ts';
import type { Site } from '../../../types/spec.d.ts';
import type { DomainAssignment, Facts, SnapCron } from '../../../types/stacks/supabase.ts';
import { addEdge, addEl, cmp, domSeg, fromSnap, methodName, resolveFn, resolveRel, schemaModule, seg, src, tomlAt, type DbCtx, type FnGroup } from './db-ctx.ts';

// ---------- functions: facts first, then groups ----------

export function groupFunctions(c: DbCtx): void {
    for (const f of c.snap.functions) {
        if (!c.shown.has(f.schema)) continue;
        const k = `${f.schema}.${f.name}`;
        if (!c.fnsByKey.has(k)) c.fnsByKey.set(k, { schema: f.schema, name: f.name, overloads: [], facts: [] });
        const g = c.fnsByKey.get(k)!;
        g.overloads.push(f);
        g.facts.push(analyzeFunction(f));
    }
}

const isTriggerFn = (g: FnGroup): boolean => g.overloads.every((f) => /^trigger$/i.test(f.returns ?? '') || /^event_trigger$/i.test(f.returns ?? ''));

// groups of public functions: the domains: a domain word of the name, else the tables used most, else the
// trigger's table; groups under DOMAINS.minGroup fold into `other`
function domainOf(c: DbCtx, g: FnGroup, triggerTable: Map<string, string>): DomainAssignment {
    const { domains } = c;
    const byName = domains.nameDomain(g.name);
    if (byName) return { domain: byName, rule: 'name' };
    const uses: { table: string; weight: number }[] = [];
    for (const facts of g.facts) {
        for (const [map, weight] of [[facts.reads, 1], [facts.writes, 2]] as const) for (const { q } of map.values()) {
            const r = resolveRel(c, q, g.schema).rel;
            if (r?.schema === 'public') uses.push({ table: r.name, weight });
        }
    }
    const byData = domains.dataDomain(uses);
    if (byData) return { domain: byData, rule: 'table' };
    const tt = triggerTable.get(`${g.schema}.${g.name}`);
    if (tt && domains.tableDomain(tt) !== 'other') return { domain: domains.tableDomain(tt), rule: 'trigger' };
    return { domain: 'other', rule: 'none' };
}

export function assignDomains(c: DbCtx): void {
    const triggerTable = new Map(c.snap.triggers.map((t) => [`${t.functionSchema}.${t.function}`, t.table]));
    for (const g of c.fnsByKey.values()) if (g.schema === 'public') c.assigned.set(g, domainOf(c, g, triggerTable));
    c.domains.fold(c.assigned, c.config.DOMAINS.minGroup);
    for (const a of c.assigned.values()) a.group = a.domain;
}

/** the functions live in the database: a module of the Postgres datastore, beside the table domains */
export function addFunctionsModule(c: DbCtx): void {
    const { snap } = c;
    addEl(c, {
        id: c.PG, type: 'module', parent: c.DB, provenance: 'extracted', name: 'Functions', technology: 'PL/pgSQL, SQL',
        source: tomlAt(c, 'db') ?? fromSnap(c, 'functions', `${snap.functions[0]?.schema}.${snap.functions[0]?.name}`),
        description: 'Logic inside the database: functions the Data API (PostgREST) serves as RPCs, trigger functions, and what pg_cron runs.',
    });
}

// second level: a large domain group splits by each function's main table — what it writes most, reads, or
// is the trigger of — when at least minGroup functions share it; the others stay in the domain group itself
function mainTable(c: DbCtx, g: FnGroup): string | undefined {
    const score = new Map<string, number>();
    const bump = (r: { schema: string; name: string } | undefined, w: number) => r?.schema === 'public' && score.set(r.name, (score.get(r.name) ?? 0) + w);
    for (const facts of g.facts) {
        for (const { q } of facts.reads.values()) bump(resolveRel(c, q, g.schema).rel, 1);
        for (const { q } of facts.writes.values()) bump(resolveRel(c, q, g.schema).rel, 2);
    }
    for (const t of c.snap.triggers) if (t.functionSchema === g.schema && t.function === g.name && t.schema === 'public') bump({ schema: 'public', name: t.table }, 3);
    return [...score].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0];
}

export function splitLargeGroups(c: DbCtx): void {
    const { DOMAINS } = c.config;
    const byDomain = new Map<string | undefined, FnGroup[]>();
    for (const [g, a] of c.assigned) (byDomain.get(a.group) ?? byDomain.set(a.group, []).get(a.group)!).push(g);
    for (const gs of byDomain.values()) {
        if (gs.length <= DOMAINS.splitAbove) continue;
        const home = new Map(gs.map((g) => [g, mainTable(c, g)]));
        const n = new Map<string, number>();
        for (const t of home.values()) if (t) n.set(t, (n.get(t) ?? 0) + 1);
        for (const [g, t] of home) if (t && n.get(t)! >= DOMAINS.minGroup) c.subgroup.set(g, t);
    }
}

function fnModuleId(c: DbCtx, g: FnGroup): string {
    if (g.schema !== 'public') return schemaModule(c, g.schema, c.PG);
    const group = c.assigned.get(g)!.group!; // every public function has a group (set above)
    const id = addEl(c, {
        id: `${c.PG}.${domSeg(c, group)}`, type: 'module', parent: c.PG, provenance: 'extracted', name: group,
        description: group === 'other' ? 'Functions with no domain word in their name and no table they mostly use.' : `Functions about «${group}»: by a word of their name, else by the table they use most.`,
        derivedFrom: { rule: 'prefix', value: group }, confidence: 'medium',
    });
    const t = c.subgroup.get(g);
    if (!t) return id;
    return addEl(c, {
        id: `${id}.around_${seg(t)}`, type: 'module', parent: id, provenance: 'extracted', name: `around ${t}`,
        description: `Functions whose main table is ${t}: what they write most, read, or are the trigger of.`,
        derivedFrom: { rule: 'usage', value: t }, confidence: 'medium',
    });
}

function addFunction(c: DbCtx, g: FnGroup): void {
    const { index, config } = c;
    const parent = fnModuleId(c, g);
    const id = `${parent}.${seg(g.name)}`;
    c.fnId.set(g, id);
    const at = index.fn(g.schema, g.name);
    const fnSrc = src(c, at, 'functions', `${g.schema}.${g.name}`);
    const f0 = g.overloads[0];
    const execBy = [...new Set(g.overloads.flatMap((f) => f.executableBy))].sort();
    addEl(c, {
        id, type: 'component', parent, provenance: 'extracted', name: g.name, description: f0.comment ?? undefined,
        technology: f0.language === 'sql' ? 'SQL function' : 'PL/pgSQL function',
        source: fnSrc,
        methods: [{ name: methodName(g.name), ...(fnSrc?.repo === c.REPO_ID ? { line: fnSrc.line } : {}) }],
        facets: {
            'pg.function': {
                schema: g.schema, language: f0.language, kind: f0.kind,
                securityDefiner: g.overloads.some((f) => f.securityDefiner) || undefined,
                volatility: f0.volatility, executableBy: execBy.length ? execBy : undefined,
                signatures: g.overloads.map((f) => `${f.name}(${f.args}) → ${f.returns}`),
            },
        },
    });
    // the Data API serves it as an RPC (trigger functions cannot be called)
    if (config.API_SCHEMAS.includes(g.schema) && !isTriggerFn(g)) {
        const anon = execBy.includes('anon') || execBy.includes('public');
        const access = anon ? { level: 'public' } : execBy.includes('authenticated') ? { level: 'authenticated' } : { level: 'restricted', roles: ['service_role'] };
        addEl(c, {
            id: `${id}.post_rest_v1_rpc_${seg(g.name)}`, type: 'endpoint', parent: id, provenance: 'extracted', name: `RPC ${g.name}`,
            handler: methodName(g.name), http: { method: 'POST', path: `/rest/v1/rpc/${g.name}` }, access, source: fnSrc,
        });
    }
}

export function addFunctions(c: DbCtx): void {
    for (const g of [...c.fnsByKey.values()].sort((a, b) => cmp(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`))) addFunction(c, g);
}

// ---------- what each function does ----------

/** Where the facts of one body come from: the (class, method) they are edges of, the schema its names resolve in. */
interface FactsAt {
    from: string;
    fromMethod: string;
    ctxSchema: string;
    site: Site | undefined;
    /** appended to the expression of an unresolved entry */
    where: string;
}

function relationEdges(c: DbCtx, facts: Facts, at: FactsAt): void {
    const { from, fromMethod, ctxSchema, site, where } = at;
    for (const [map, channel] of [[facts.reads, 'read'], [facts.writes, 'write']] as const) {
        for (const { q, ops } of map.values()) {
            const r = resolveRel(c, q, ctxSchema);
            if (r.rel) addEdge(c, { from, fromMethod, to: r.rel.id, channel, ops: [...ops], source: site });
            else if (r.skip) c.skipped[r.skip]++;
            else c.unresolved.push({ kind: 'unknown-relation', ...(site ?? {}), element: from, method: fromMethod, expr: `${channel} ${q.schema ? `${q.schema}.` : ''}${q.name}${where}` });
        }
    }
}

function callEdges(c: DbCtx, facts: Facts, at: FactsAt): void {
    const { from, fromMethod, ctxSchema, site } = at;
    for (const q of facts.calls.values()) {
        const g = resolveFn(c, q, ctxSchema);
        if (g === undefined) continue; // a built-in or an extension's function
        if (g === null) {
            c.skipped.hiddenSchemaCalls++;
            continue;
        }
        const to = c.fnId.get(g);
        if (to === from && methodName(g.name) === fromMethod) continue; // recursion
        addEdge(c, { from, fromMethod, to, toMethod: methodName(g.name), channel: 'call', source: site });
    }
}

function factEdges(c: DbCtx, facts: Facts, at: FactsAt): void {
    const { from, fromMethod, site, where } = at;
    relationEdges(c, facts, at);
    callEdges(c, facts, at);
    for (const h of facts.http) {
        // an HTTP call out of Postgres: the Edge Functions document resolves it (its routes are known there)
        const entry = { kind: h.url ? 'edge-function-call' : 'http-unknown', ...(site ?? {}), element: from, method: fromMethod, expr: `${h.expr}(${h.url ?? '?'})${where}` };
        c.unresolved.push(entry);
        if (h.url) c.httpCalls.push({ from, fromMethod, url: h.url, channel: from === cronId(c) ? 'schedule' : 'rest', label: c.schedLabel, source: site, entry });
    }
    for (const u of facts.unresolved) c.unresolved.push({ kind: u.kind, ...(site ?? {}), element: from, method: fromMethod, expr: `${u.expr}${where}` });
}

export function addFunctionEdges(c: DbCtx): void {
    for (const g of c.fnsByKey.values()) {
        const id = c.fnId.get(g)!;
        const site = src(c, c.index.fn(g.schema, g.name), 'functions', `${g.schema}.${g.name}`);
        for (const facts of g.facts) factEdges(c, facts, { from: id, fromMethod: methodName(g.name), ctxSchema: g.schema, site, where: '' });
    }
}

// ---------- triggers ----------

export function addTriggers(c: DbCtx): void {
    const { snap, index } = c;
    for (const t of snap.triggers) {
        const from = c.rels.get(`${t.schema}.${t.table}`);
        const g = c.fnsByKey.get(`${t.functionSchema}.${t.function}`);
        const head = /\b(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s/i.exec(t.definition);
        const each = /FOR EACH (ROW|STATEMENT)/i.exec(t.definition)?.[1]?.toLowerCase();
        const label = `${t.name}: ${head ? `${head[1].toLowerCase()} ${head[2].toLowerCase()}` : ''}${each ? `, for each ${each}` : ''}${t.enabled ? '' : ' (disabled)'}`;
        if (from && g) {
            const e = addEdge(c, { from: from.id, to: c.fnId.get(g), toMethod: methodName(g.name), channel: 'trigger', label, source: src(c, index.trigger(t.name), 'triggers', `${t.schema}.${t.table}.${t.name}`) });
            ((e.facets ??= { 'pg.trigger': { triggers: [] } })['pg.trigger'] as { triggers: unknown[] }).triggers.push({ name: t.name, definition: t.definition, enabled: t.enabled });
        } else if (from && t.functionSchema === 'supabase_functions' && t.function === 'http_request') {
            const url = /'(https?:[^']+)'/.exec(t.definition)?.[1];
            const entry = { kind: 'edge-function-call', element: from.id, expr: `database webhook ${t.name}: ${url ?? '?'}` };
            c.unresolved.push(entry);
            if (url) c.httpCalls.push({ from: from.id, url, channel: 'rest', label: `database webhook ${t.name}`, source: src(c, index.trigger(t.name), 'triggers', `${t.schema}.${t.table}.${t.name}`), entry });
        } else if (from && !c.shown.has(t.functionSchema)) c.skipped.hiddenSchemaCalls++;
    }
}

// ---------- pg_cron: one rail, a topic per job ----------

const cronId = (c: DbCtx): string => `${c.PG}.pg_cron`;

function jobMethodNames(cron: SnapCron[]): Map<SnapCron, string> {
    const jobMethods = new Map<SnapCron, string>();
    for (const j of cron) {
        let m = methodName(j.name);
        for (let i = 2; [...jobMethods.values()].includes(m); i++) m = `${methodName(j.name)}_${i}`;
        jobMethods.set(j, m);
    }
    return jobMethods;
}

export function addCron(c: DbCtx): void {
    const { snap } = c;
    const jobMethods = jobMethodNames(snap.cron);
    const CRON = cronId(c);
    addEl(c, {
        id: CRON, type: 'job', parent: c.PG, provenance: 'extracted', name: 'pg_cron', technology: 'pg_cron', source: fromSnap(c, 'cron', snap.cron[0]?.name),
        description: 'Jobs on a schedule inside Postgres: SQL ones run a function, HTTP ones call an Edge Function through pg_net.',
        facets: { 'pg.cron': { jobs: snap.cron.map((j) => ({ method: jobMethods.get(j), name: j.name, schedule: j.schedule, active: j.active })) } },
    });
    for (const j of snap.cron) {
        const facts = analyzeSql(j.command);
        const m = jobMethods.get(j)!;
        // a scheduled call is `schedule`, not `call`: the job starts the function on time
        for (const q of facts.calls.values()) {
            const g = resolveFn(c, q, 'public');
            if (g) {
                facts.calls.delete(`${q.schema ?? ''}.${q.name}`);
                addEdge(c, { from: CRON, fromMethod: m, to: c.fnId.get(g), toMethod: methodName(g.name), channel: 'schedule', label: `${j.schedule}${j.active ? '' : ' (inactive)'}`, source: fromSnap(c, 'cron', j.name) });
            }
        }
        c.schedLabel = `${j.schedule}${j.active ? '' : ' (inactive)'}`;
        factEdges(c, facts, { from: CRON, fromMethod: m, ctxSchema: 'public', site: fromSnap(c, 'cron', j.name), where: ` (cron «${j.name}», ${j.schedule})` });
        c.schedLabel = undefined;
    }
}
