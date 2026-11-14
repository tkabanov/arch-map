// Domains of a Supabase project: one vocabulary for the tables of Postgres, the SQL functions and the Edge
// Functions, so «job» is the same cluster in all three and a line between two of them reads as «job → job».
// A table's domain is the first word of its name (synonyms folded); a domain with fewer than `minTables` tables is
// `other`. A function's domain is the first word of its name that is a domain, else the domain it touches most
// (writes count twice), else what the caller says (a trigger's table), else `other`. Pure.
import type { DomainAssignment, Domains, DomainsConfig } from '../../../types/stacks/supabase.ts';

export function makeDomains(cfg: DomainsConfig, publicTables: string[]): Domains {
    const syn = (w: string): string => {
        let x = w;
        for (let i = 0; i < 4 && Object.hasOwn(cfg.synonyms, x); i++) x = cfg.synonyms[x];
        return x;
    };
    const first = (name: string) => syn(String(name).split(/[_-]/)[0]);
    const raw = new Map(publicTables.map((t) => [t, first(t)]));
    const size = new Map<string, number>();
    for (const d of raw.values()) size.set(d, (size.get(d) ?? 0) + 1);
    const ok = (d: string) => (size.get(d) ?? 0) >= cfg.minTables && !cfg.notDomains.includes(d);
    const tableDomain = (t: string): string => (raw.has(t) && ok(raw.get(t)!) ? raw.get(t)! : 'other');
    const vocab = new Set([...[...size.keys()].filter(ok), ...cfg.extraWords.map(syn)]);
    /** the domain a name says (`publish-job` → job), or undefined */
    const nameDomain = (name: string) => {
        for (const w of String(name).split(/[_-]/).map(syn)) if (vocab.has(w)) return w;
        return undefined;
    };
    /** the domain of what a part touches most: [{ table, weight }] */
    const dataDomain = (uses: Iterable<{ table: string; weight: number }>) => {
        const score = new Map<string, number>();
        for (const { table, weight } of uses) {
            const d = tableDomain(table);
            if (d !== 'other') score.set(d, (score.get(d) ?? 0) + weight);
        }
        return [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    };
    /** groups smaller than `min` fold into `other`: Map(key → domain) in place */
    const fold = <K, A extends DomainAssignment>(assigned: Map<K, A>, min: number): Map<K, A> => {
        const n = new Map<string, number>();
        for (const a of assigned.values()) n.set(a.domain, (n.get(a.domain) ?? 0) + 1);
        for (const a of assigned.values())
            if ((n.get(a.domain) ?? 0) < min) {
                a.domain = 'other';
                a.rule = 'small';
            }
        return assigned;
    };
    return { tableDomain, nameDomain, dataDomain, fold, vocab };
}
