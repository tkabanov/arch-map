// Where an object of a Supabase project's database is written in the repo: a text index over the migration
// files, used only for `source` links. The schema itself comes from the snapshot, never from migrations; a name found
// here does not mean the object exists, and an object missing here (the repo behind dev) simply has no link.
// Also a minimal reader of supabase/config.toml: sections, simple values and their lines.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FileLine, MigrationIndex, SnapAt, Toml, TomlSection } from '../../../types/stacks/supabase.ts';

const ident = String.raw`"?([A-Za-z_][\w$]*)"?`;
const qual = String.raw`(?:${ident}\s*\.\s*)?${ident}`;
const RX = {
    fn: new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${qual}\s*\(`, 'i'),
    table: new RegExp(String.raw`create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${qual}`, 'i'),
    rename: new RegExp(String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${qual}\s+rename\s+to\s+${ident}`, 'i'),
    view: new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${qual}`, 'i'),
    trigger: new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+${ident}`, 'i'),
};
const k = (schema: string | null | undefined, name: string): string => `${(schema ?? 'public').toLowerCase()}.${name.toLowerCase()}`;

/** { fn(schema, name), table(schema, name), view(schema, name), trigger(name) } → { file, line } | undefined */
export function migrationIndex(root: string | null | undefined, dir: string): Required<MigrationIndex> {
    const fns = new Map<string, FileLine>(), tables = new Map<string, FileLine>(), views = new Map<string, FileLine>(), triggers = new Map<string, FileLine>();
    const abs = root && join(root, dir);
    if (abs && existsSync(abs)) {
        for (const f of readdirSync(abs).filter((x) => x.endsWith('.sql')).sort()) {
            const file = `${dir}/${f}`;
            const lines = readFileSync(join(abs, f), 'utf8').split('\n');
            lines.forEach((text, i) => {
                const at = { file, line: i + 1 };
                let m: RegExpExecArray | null;
                if ((m = RX.fn.exec(text))) fns.set(k(m[1], m[2]), at); // last definition wins
                if ((m = RX.table.exec(text)) && !tables.has(k(m[1], m[2]))) tables.set(k(m[1], m[2]), at); // first
                if ((m = RX.rename.exec(text))) tables.set(k(m[1], m[3]), at); // a rename creates the new name
                if ((m = RX.view.exec(text))) views.set(k(m[1], m[2]), at);
                if ((m = RX.trigger.exec(text))) triggers.set(m[1].toLowerCase(), at);
            });
        }
    }
    return {
        fn: (s, n) => fns.get(k(s, n)),
        table: (s, n) => tables.get(k(s, n)),
        view: (s, n) => views.get(k(s, n)),
        trigger: (n) => triggers.get(n.toLowerCase()),
        newest: () => (abs && existsSync(abs) ? readdirSync(abs).filter((x) => x.endsWith('.sql')).sort().at(-1)?.slice(0, 14) : undefined),
    };
}

/** supabase/config.toml → Map(section → { line, values: Map(key → { value, line }) }); simple values only. */
export function readToml(path: string | null | undefined): Toml {
    const sections: Toml = new Map();
    if (!path || !existsSync(path)) return sections;
    let cur: TomlSection = { line: 0, values: new Map() };
    sections.set('', cur);
    readFileSync(path, 'utf8')
        .split('\n')
        .forEach((raw, i) => {
            const text = raw.replace(/\s+#.*$/, '').trim();
            let m: RegExpExecArray | null;
            if ((m = /^\[([^\]]+)\]$/.exec(text))) sections.set(m[1], (cur = { line: i + 1, values: new Map() }));
            else if ((m = /^([\w.-]+)\s*=\s*(.+)$/.exec(text))) {
                let v: unknown = m[2];
                try {
                    v = JSON.parse(v as string);
                } catch {
                    /* keep the text */
                }
                cur.values.set(m[1], { value: v, line: i + 1 });
            }
        });
    return sections;
}

/**
 * Lines of the snapshot file (written with one-space indent: sections at 1 space, items at 2, fields at 3), so a fact
 * taken from the snapshot can point at where it is: (section, key) → line. Keys: tables/views/functions →
 * `schema.name`, triggers → `schema.table.name`, policies → `schema.table.name`, cron → name, realtime →
 * `schema.table`, buckets → id; the first item wins (function overloads).
 */
export function snapshotIndex(text: string): SnapAt {
    const at = new Map<string, number>();
    let section: string | null = null;
    let item: { line: number; fields: Record<string, string> } | null = null;
    const flush = () => {
        if (!item) return;
        const f = item.fields;
        const key =
            section === 'triggers' || section === 'policies' ? `${f.schema}.${f.table}.${f.name}`
            : section === 'realtime' ? `${f.schema}.${f.table}`
            : section === 'cron' ? f.name
            : section === 'buckets' ? f.id
            : `${f.schema}.${f.name}`;
        const k = `${section}|${key}`;
        if (!at.has(k)) at.set(k, item.line);
        item = null;
    };
    text.split('\n').forEach((line, i) => {
        let m: RegExpExecArray | null;
        if ((m = /^ "(\w+)": [[{]/.exec(line))) {
            flush();
            section = m[1];
        } else if (/^ {2}\{$/.test(line)) {
            flush();
            item = { line: i + 1, fields: {} };
        } else if (item && (m = /^ {3}"(schema|name|table|id)": "([^"]*)"/.exec(line))) item.fields[m[1]] = m[2];
    });
    flush();
    return (section, key) => at.get(`${section}|${key}`);
}
