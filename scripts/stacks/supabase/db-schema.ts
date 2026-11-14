// `buildSupabaseSpec`, the schema: the Postgres datastore, tables and views with columns, grants and RLS, Supabase's
// auth.users when the system touches it, foreign keys and the reads of views.
import type { SnapTable } from '../../../types/stacks/supabase.ts';
import { addEdge, addEl, domSeg, fromSnap, putRel, relId, schemaModule, src, tomlAt, type DbCtx } from './db-ctx.ts';

export function addDatabase(c: DbCtx): void {
    const { snap } = c;
    addEl(c, {
        id: c.DB, type: 'datastore', parent: null, provenance: 'extracted', name: 'Postgres',
        technology: `Postgres ${snap.meta.postgres} (Supabase)`,
        description: `The ${c.config.NAME} database, from a read-only snapshot of ${snap.env} (${snap.takenAt.slice(0, 10)}, last migration ${snap.meta.lastMigration}).`,
        source: tomlAt(c, 'db') ?? fromSnap(c, 'tables', `${snap.tables[0]?.schema}.${snap.tables[0]?.name}`),
        facets: { 'pg.snapshot': { env: snap.env, takenAt: snap.takenAt, lastMigration: snap.meta.lastMigration, appliedMigrations: snap.meta.appliedMigrations } },
    });
}

function tableCluster(c: DbCtx, name: string): string {
    const d = c.domains.tableDomain(name);
    return addEl(c, {
        id: `${c.DB}.${domSeg(c, d)}`, type: 'module', parent: c.DB, provenance: 'extracted', name: d,
        description: d === 'other' ? 'Tables of small domains (fewer than three tables share the first word of their name).' : `Tables about «${d}» (the first word of their name).`,
        derivedFrom: { rule: 'prefix', value: d }, confidence: 'medium',
    });
}

function addTable(c: DbCtx, t: SnapTable): void {
    const { index } = c;
    const parent = t.schema === 'public' ? tableCluster(c, t.name) : schemaModule(c, t.schema);
    const id = relId(c, t.schema, t.name);
    const pols = c.policiesOf.get(`${t.schema}.${t.name}`) ?? [];
    addEl(c, {
        id, type: 'table', parent, provenance: 'extracted', name: t.name, description: t.comment ?? undefined,
        source: src(c, index.table(t.schema, t.name), 'tables', `${t.schema}.${t.name}`),
        columns: t.columns.map((col) => ({ name: col.name, type: col.type, nullable: !col.notNull, pk: (t.pk ?? []).includes(col.name) })),
        facets: {
            'pg.table': {
                schema: t.schema, kind: t.kind, rls: t.rls, forceRls: t.forceRls || undefined,
                realtime: c.realtime.has(`${t.schema}.${t.name}`) || undefined,
                grants: Object.fromEntries(['anon', 'authenticated'].map((r) => [r, t.grants.filter((g) => g.role === r).map((g) => g.privilege.toLowerCase())]).filter(([, v]) => v.length)),
            },
            ...(pols.length ? { 'pg.rls': { policies: pols.map((p) => ({ name: p.name, command: p.command, roles: p.roles, permissive: p.permissive, using: p.using ?? undefined, withCheck: p.withCheck ?? undefined })) } } : {}),
        },
    });
    putRel(c, { id, schema: t.schema, name: t.name, kind: 'table', table: t });
}

export function addTables(c: DbCtx): void {
    for (const t of c.snap.tables) {
        if (!c.shown.has(t.schema)) continue;
        addTable(c, t);
    }
}

export function addViews(c: DbCtx): void {
    const { snap, index } = c;
    for (const v of snap.views) {
        if (!c.shown.has(v.schema)) continue;
        const parent = v.schema === 'public' ? tableCluster(c, v.name) : schemaModule(c, v.schema);
        const id = relId(c, v.schema, v.name);
        addEl(c, {
            id, type: 'table', parent, provenance: 'extracted', name: v.name, description: v.comment ?? undefined,
            technology: v.kind === 'materialized' ? 'materialized view' : 'view',
            source: src(c, index.view(v.schema, v.name), 'views', `${v.schema}.${v.name}`),
            columns: v.columns.map((col) => ({ name: col.name, type: col.type, nullable: true, pk: false })),
            facets: { 'pg.view': { schema: v.schema, kind: v.kind } },
        });
        putRel(c, { id, schema: v.schema, name: v.name, kind: 'view', view: v });
    }
}

/** Supabase's own tables the system's code touches: auth.users (sign-up triggers, foreign keys) */
export function addAuthUsers(c: DbCtx): void {
    const { snap } = c;
    if (!c.authUsers) return;
    const parent = schemaModule(c, 'auth', c.DB, { context: true, description: 'Supabase Auth\'s schema; only what the system touches is shown.' });
    const id = relId(c, 'auth', 'users');
    const t0 = snap.triggers.find((t) => t.schema === 'auth' && t.table === 'users');
    const fk0 = snap.tables.find((t) => t.fks.some((f) => f.refSchema === 'auth' && f.refTable === 'users'));
    addEl(c, {
        id, type: 'table', parent, provenance: 'extracted', name: 'users', context: true, description: 'Accounts of Supabase Auth (GoTrue writes them on sign-up and sign-in).',
        source: t0 ? fromSnap(c, 'triggers', `auth.users.${t0.name}`) : fromSnap(c, 'tables', `${fk0!.schema}.${fk0!.name}`), // authUsers: one of the two exists
    });
    putRel(c, { id, schema: 'auth', name: 'users', kind: 'table' });
}

// ---------- foreign keys, view reads ----------

export function addReferenceEdges(c: DbCtx): void {
    const { snap, index, rels } = c;
    for (const t of snap.tables) {
        const from = rels.get(`${t.schema}.${t.name}`);
        if (!from) continue;
        for (const f of t.fks) {
            const to = rels.get(`${f.refSchema}.${f.refTable}`);
            if (!to || to.id === from.id) continue;
            addEdge(c, { from: from.id, to: to.id, channel: 'references', ops: f.columns, source: src(c, index.table(t.schema, t.name), 'tables', `${t.schema}.${t.name}`) });
        }
    }
    for (const v of snap.views) {
        const from = rels.get(`${v.schema}.${v.name}`);
        if (!from) continue;
        for (const r of v.reads) {
            const to = rels.get(`${r.schema}.${r.name}`);
            if (to && to.id !== from.id) addEdge(c, { from: from.id, to: to.id, channel: 'read', ops: ['select'], label: 'view', source: src(c, index.view(v.schema, v.name), 'views', `${v.schema}.${v.name}`) });
        }
    }
}
