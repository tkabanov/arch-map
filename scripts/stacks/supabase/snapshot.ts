// Takes a read-only snapshot of a Supabase project's database schema and writes `<outDir>/<env>-schema.json`. The
// extractor reads that file, never the database. The project's snapshot script calls `takeDbSnapshot` with its config.
//
// Read only, catalog only: every query goes through the project's SQL runner (`sql`: an executable called as
// `<sql> <env> <query>`, e.g. a workspace's Management API read-only endpoint, role supabase_read_only_user) and reads
// pg_catalog / pg_policies / cron.job — no table rows. Migrations are a history, not a state, so the schema is taken
// from a live database.
// Strings that look like secrets (JWTs, API keys, bearer tokens) are replaced by «[redacted]»: the file is committed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DbSnapshot } from '../../../types/stacks/supabase.ts';

/** `takeDbSnapshot` input: the SQL runner, the environment, the schemas the system is made of, the folder to write. */
export interface DbSnapshotInput {
    /** executable called as `<sql> <env> <query>`; prints a JSON array of rows */
    sql: string;
    env: string;
    /** schemas the system is made of; the rest (auth, storage, vault, cron, net, gis = PostGIS, …) belong to Supabase and extensions */
    schemas: string[];
    /** absolute folder of the committed snapshots */
    outDir: string;
}

/** Takes the snapshot (exits the process with a message on a failed query or a count mismatch); returns the file written. */
export function takeDbSnapshot({ sql: SQL, env, schemas: SCHEMAS, outDir }: DbSnapshotInput): string {
    const inSchemas = `(${SCHEMAS.map((s) => `'${s}'`).join(', ')})`;
    /** Objects that belong to an extension (pgvector, pg_trgm, …) are not the system's code. */
    const notExt = (oid: string, cls: string): string => `not exists (select 1 from pg_depend d where d.objid = ${oid} and d.classid = '${cls}'::regclass and d.deptype = 'e')`;

    /** Each query returns one row with one column `rows`: a json array in a stable order. */
    const QUERIES = {
        meta: `
            select json_build_object(
                'postgres', current_setting('server_version'),
                'role', current_user,
                'lastMigration', (select max(version) from supabase_migrations.schema_migrations),
                'appliedMigrations', (select count(*) from supabase_migrations.schema_migrations),
                'otherSchemas', (select coalesce(json_agg(nspname order by nspname), '[]') from pg_namespace
                    where nspname not in ${inSchemas} and nspname not like 'pg\\_%' and nspname <> 'information_schema')
            ) as rows`,
        tables: `
            select coalesce(json_agg(t order by t.schema, t.name), '[]') as rows from (
                select n.nspname as schema, c.relname as name,
                    case c.relkind when 'p' then 'partitioned' else 'table' end as kind,
                    obj_description(c.oid, 'pg_class') as comment,
                    c.relrowsecurity as rls, c.relforcerowsecurity as "forceRls",
                    (select coalesce(json_agg(json_build_object(
                        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
                        'default', pg_get_expr(ad.adbin, ad.adrelid), 'comment', col_description(c.oid, a.attnum))
                        order by a.attnum), '[]')
                     from pg_attribute a left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
                     where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
                    (select json_agg(a.attname order by k.i) from pg_constraint pk,
                        unnest(pk.conkey) with ordinality k(attnum, i)
                        join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
                     where pk.conrelid = c.oid and pk.contype = 'p') as pk,
                    (select coalesce(json_agg(json_build_object(
                        'name', f.conname,
                        'columns', (select json_agg(a.attname order by k.i) from unnest(f.conkey) with ordinality k(attnum, i)
                            join pg_attribute a on a.attrelid = f.conrelid and a.attnum = k.attnum),
                        'refSchema', rn.nspname, 'refTable', rc.relname,
                        'refColumns', (select json_agg(a.attname order by k.i) from unnest(f.confkey) with ordinality k(attnum, i)
                            join pg_attribute a on a.attrelid = f.confrelid and a.attnum = k.attnum),
                        'onDelete', f.confdeltype) order by f.conname), '[]')
                     from pg_constraint f join pg_class rc on rc.oid = f.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
                     where f.conrelid = c.oid and f.contype = 'f') as fks,
                    (select coalesce(json_agg(json_build_object('role', r.rolname, 'privilege', x.privilege_type)
                        order by r.rolname, x.privilege_type), '[]')
                     from aclexplode(c.relacl) x join pg_roles r on r.oid = x.grantee
                     where r.rolname in ('anon', 'authenticated')) as grants
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where c.relkind in ('r', 'p') and n.nspname in ${inSchemas} and not c.relispartition
                    and ${notExt('c.oid', 'pg_class')}
            ) t`,
        views: `
            select coalesce(json_agg(v order by v.schema, v.name), '[]') as rows from (
                select n.nspname as schema, c.relname as name,
                    case c.relkind when 'm' then 'materialized' else 'view' end as kind,
                    obj_description(c.oid, 'pg_class') as comment,
                    (select coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod))
                        order by a.attnum), '[]')
                     from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
                    (select coalesce(json_agg(distinct jsonb_build_object('schema', dn.nspname, 'name', dc.relname)), '[]')
                     from pg_rewrite rw join pg_depend d on d.objid = rw.oid and d.classid = 'pg_rewrite'::regclass
                        join pg_class dc on dc.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
                        join pg_namespace dn on dn.oid = dc.relnamespace
                     where rw.ev_class = c.oid and dc.oid <> c.oid) as reads,
                    (select coalesce(json_agg(distinct jsonb_build_object('schema', pn.nspname, 'name', p.proname)), '[]')
                     from pg_rewrite rw join pg_depend d on d.objid = rw.oid and d.classid = 'pg_rewrite'::regclass
                        join pg_proc p on p.oid = d.refobjid and d.refclassid = 'pg_proc'::regclass
                        join pg_namespace pn on pn.oid = p.pronamespace
                     where rw.ev_class = c.oid and pn.nspname in ${inSchemas}) as calls,
                    pg_get_viewdef(c.oid, true) as definition,
                    (select coalesce(json_agg(json_build_object('role', r.rolname, 'privilege', x.privilege_type)
                        order by r.rolname, x.privilege_type), '[]')
                     from aclexplode(c.relacl) x join pg_roles r on r.oid = x.grantee
                     where r.rolname in ('anon', 'authenticated')) as grants
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where c.relkind in ('v', 'm') and n.nspname in ${inSchemas} and ${notExt('c.oid', 'pg_class')}
            ) v`,
        functions: `
            select coalesce(json_agg(f order by f.schema, f.name, f.args), '[]') as rows from (
                select n.nspname as schema, p.proname as name,
                    pg_get_function_identity_arguments(p.oid) as args,
                    pg_get_function_result(p.oid) as returns,
                    case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window' else 'function' end as kind,
                    l.lanname as language, p.prosecdef as "securityDefiner",
                    case p.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end as volatility,
                    obj_description(p.oid, 'pg_proc') as comment,
                    -- who may call it through the Data API (/rest/v1/rpc): PUBLIC (grantee 0) counts for both roles
                    (select coalesce(json_agg(distinct coalesce(r.rolname, 'public') order by coalesce(r.rolname, 'public')), '[]')
                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x left join pg_roles r on r.oid = x.grantee
                     where x.privilege_type = 'EXECUTE' and (x.grantee = 0 or r.rolname in ('anon', 'authenticated'))) as "executableBy",
                    p.prosrc as body
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
                where n.nspname in ${inSchemas} and l.lanname in ('sql', 'plpgsql') and ${notExt('p.oid', 'pg_proc')}
            ) f`,
        triggers: `
            select coalesce(json_agg(t order by t.schema, t.table, t.name), '[]') as rows from (
                select n.nspname as schema, c.relname as table, tg.tgname as name,
                    pn.nspname as "functionSchema", p.proname as "function",
                    tg.tgenabled <> 'D' as enabled,
                    pg_get_triggerdef(tg.oid, true) as definition
                from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
                    join pg_proc p on p.oid = tg.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
                -- on the system's tables, and on Supabase's (auth.users, storage.objects) when they start the system's functions
                where not tg.tgisinternal and (n.nspname in ${inSchemas} or pn.nspname in ${inSchemas})
            ) t`,
        policies: `
            select coalesce(json_agg(json_build_object(
                'schema', schemaname, 'table', tablename, 'name', policyname, 'permissive', permissive = 'PERMISSIVE',
                'roles', roles, 'command', lower(cmd), 'using', qual, 'withCheck', with_check)
                order by schemaname, tablename, policyname), '[]') as rows
            from pg_policies where schemaname in ${inSchemas} or schemaname = 'storage'`,
        enums: `
            select coalesce(json_agg(e order by e.schema, e.name), '[]') as rows from (
                select n.nspname as schema, t.typname as name,
                    (select json_agg(enumlabel order by enumsortorder) from pg_enum where enumtypid = t.oid) as labels
                from pg_type t join pg_namespace n on n.oid = t.typnamespace
                where t.typtype = 'e' and n.nspname in ${inSchemas} and ${notExt('t.oid', 'pg_type')}
            ) e`,
        cron: `
            select coalesce(json_agg(json_build_object('name', jobname, 'schedule', schedule, 'active', active, 'command', command)
                order by jobname, jobid), '[]') as rows from cron.job`,
        realtime: `
            select coalesce(json_agg(json_build_object('schema', schemaname, 'table', tablename) order by schemaname, tablename), '[]') as rows
            from pg_publication_tables where pubname = 'supabase_realtime'`,
        buckets: `
            select coalesce(json_agg(json_build_object('id', id, 'public', public, 'fileSizeLimit', file_size_limit,
                'allowedMimeTypes', allowed_mime_types) order by id), '[]') as rows from storage.buckets`,
        /** Counted separately from the lists above, to check that nothing was cut on the way. */
        counts: `
            select json_build_object(
                'tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where c.relkind in ('r', 'p') and n.nspname in ${inSchemas} and not c.relispartition and ${notExt('c.oid', 'pg_class')}),
                'views', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where c.relkind in ('v', 'm') and n.nspname in ${inSchemas} and ${notExt('c.oid', 'pg_class')}),
                'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
                    where n.nspname in ${inSchemas} and l.lanname in ('sql', 'plpgsql') and ${notExt('p.oid', 'pg_proc')}),
                'triggers', (select count(*) from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
                    where not tg.tgisinternal and (n.nspname in ${inSchemas} or exists (select 1 from pg_proc p join pg_namespace pn on pn.oid = p.pronamespace
                        where p.oid = tg.tgfoid and pn.nspname in ${inSchemas}))),
                'policies', (select count(*) from pg_policies where schemaname in ${inSchemas} or schemaname = 'storage'),
                'cron', (select count(*) from cron.job)
            ) as rows`,
    };

    function run(name: string, sql: string): unknown {
        let out: string;
        try {
            out = execFileSync(SQL, [env, sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            const err = e as { stdout?: string; stderr?: string };
            console.error(`snapshot: query «${name}» failed\n${err.stdout ?? ''}${err.stderr ?? ''}`);
            process.exit(1);
        }
        const rows = JSON.parse(out);
        if (!Array.isArray(rows) || rows.length !== 1 || !('rows' in rows[0])) {
            console.error(`snapshot: query «${name}» returned an unexpected shape: ${out.slice(0, 300)}`);
            process.exit(1);
        }
        return rows[0].rows;
    }

    // ---------- secrets ----------
    const SECRET_PATTERNS = [
        /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT (service-role / anon keys)
        /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe keys
        /\bwhsec_[A-Za-z0-9]{10,}/g, // Stripe webhook secrets
        /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g, // Supabase new-style keys
        /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // SendGrid
        /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style
        /(Bearer\s+)(?!\s*'\s*\|\|)[A-Za-z0-9._~+/=-]{20,}/gi, // a literal bearer token (not one concatenated from a variable)
        // key: '…' / 'apikey', '…' — a value with both letters and digits (not a table name like public.api_key_usage)
        /((?:api[_-]?key|apikey|token|secret|password)["']?\s*[:=,]\s*["'])(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{20,}(?=["'])/gi,
        /(:\/\/[^:/@\s'"]+:)[^@\s'"]{6,}(?=@)/g, // password in a connection string
        // a literal compared with a secret-named variable: `p_client_secret = '…'` (whatever it looks like)
        /(\b\w*(?:secret|password|passwd|token)\w*\s*(?:=|<>|!=)\s*')[^'\s]{8,}(?=')/gi,
    ];
    let redactions = 0;
    function redact(value: unknown): unknown {
        if (typeof value === 'string') {
            let s = value;
            for (const re of SECRET_PATTERNS)
                s = s.replace(re, (...m) => {
                    redactions++;
                    const prefix = typeof m[1] === 'string' && m.length > 3 ? m[1] : '';
                    return `${prefix}[redacted]`;
                });
            return s;
        }
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
        return value;
    }

    // ---------- run ----------
    const started = Date.now();
    const snap: Record<string, unknown> = { env, takenAt: new Date().toISOString(), schemas: SCHEMAS };
    for (const [name, sql] of Object.entries(QUERIES)) snap[name] = run(name, sql);

    const counts = snap.counts as Record<string, unknown>;
    delete snap.counts;
    const list = (k: string): unknown[] => snap[k] as unknown[];
    const mismatch = Object.entries(counts).filter(([k, n]) => list(k).length !== Number(n));
    if (mismatch.length) {
        console.error(`snapshot: lists and counts differ: ${mismatch.map(([k, n]) => `${k} ${list(k).length} ≠ ${n}`).join(', ')}`);
        process.exit(1);
    }

    const out = redact(snap) as DbSnapshot;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${env}-schema.json`);
    writeFileSync(file, JSON.stringify(out, null, 1) + '\n');

    const m = out.meta;
    console.log(
        `snapshot: ${env} (Postgres ${m.postgres}, as ${m.role}, last migration ${m.lastMigration}, ${m.appliedMigrations} applied) → ` +
            `${relative(process.cwd(), file)}\n  ${out.tables.length} tables, ${out.views.length} views, ${out.functions.length} functions, ` +
            `${out.triggers.length} triggers, ${out.policies.length} policies, ${out.enums.length} enums, ${out.cron.length} cron jobs, ` +
            `${out.realtime.length} realtime tables, ${out.buckets.length} buckets; ${redactions} secret-like strings redacted; ` +
            `${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
    return file;
}
