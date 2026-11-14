import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchMapSpecDocument } from 'arch-map/types/spec';
import type { UnresolvedEntry } from 'arch-map/types/generator';

/** Hash source content instead of the enclosing checkout's changing commit. No local paths or clocks in specs. */
export function targetHash(root: string): string {
    const hash = createHash('sha256');
    const visit = (dir: string): void => {
        for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) visit(path);
            else { hash.update(path); hash.update(readFileSync(join(root, path))); }
        }
    };
    visit('');
    return hash.digest('hex').slice(0, 12);
}
export function tally(items: string[]): Record<string, number> {
    return Object.fromEntries([...new Set(items)].sort().map((key) => [key, items.filter((item) => item === key).length]));
}
export function writeReport(out: string, name: string, result: { doc: ArchMapSpecDocument; unresolved: UnresolvedEntry[] }): void {
    const counts = { elements: tally(result.doc.elements.map((el) => el.type)), edges: tally(result.doc.edges.map((edge) => edge.channel)) };
    writeFileSync(join(out, `${name}.unresolved.json`), `${JSON.stringify({ entries: result.unresolved }, null, 2)}\n`);
    console.log(name, JSON.stringify(counts));
}
