// Validates spec documents and checks them as a set (docs/architecture.md AD-1, AD-2, AD-7, AD-8):
// schema + id rules, merge (unique ids, `requires` scoping, claims, overrides), contract pointers and
// envelope keys, scenario steps (resolve, and have a contract). Rules: scripts/lib/spec-set.ts → core/.
// Usage: node scripts/check-specs.ts [<project> ...]            each project's documents as a set of its own (default: every project)
//        node scripts/check-specs.ts index.json | doc.json ...  one set from an index file and/or documents
// Across projects: document names are unique (checked when the manifests load, scripts/lib/projects.ts); an element id
// in two projects is a warning.
// Prints every problem as `<file>:<line>: <message> (<id>)` and exits 1 if there is any.
import { join } from 'node:path';
import { formatError } from './lib/spec-io.ts';
import { documentPaths, checkSpecSet, type CheckedSet } from './lib/spec-set.ts';
import { pickProjects, areProjectNames, noProjects } from './lib/projects.ts';
import type { SpecError } from '../types/generator.ts';

const args = process.argv.slice(2);
const byPath = args.length && !areProjectNames(args);

/** Checks one set and prints its line; true when it has no errors. */
function report(label: string, paths: string[], pathErrors: SpecError[] = []): CheckedSet | null {
    const { loaded, merged, scenarios, errors } = checkSpecSet(paths);
    errors.unshift(...pathErrors);
    if (errors.length) {
        for (const e of errors) console.error(formatError(e));
        console.error(`check-specs: ${label}${errors.length} error${errors.length === 1 ? '' : 's'} in ${loaded.length} document(s)`);
        return null;
    }
    // no errors: the set merged and its scenarios resolved
    const steps = scenarios!.reduce((n, s) => n + s.resolved.length, 0);
    const claimed = merged!.elements.filter((e) => (e.type === 'app' || e.type === 'datastore') && e.parent).length;
    console.log(
        `check-specs: ${label}ok — ${loaded.length} document(s), ${merged!.elements.length} elements, ${merged!.edges.length} edges` +
            (merged!.scenarios.length ? `, ${merged!.scenarios.length} scenarios (${steps} steps)` : '') +
            (claimed ? `, ${claimed} apps/datastores claimed` : '') +
            (Object.keys(merged!.envelopes).length ? `, ${Object.keys(merged!.envelopes).length} envelopes` : ''),
    );
    return { loaded, merged, scenarios, errors };
}

if (byPath) {
    const pathErrors: SpecError[] = [];
    const paths = documentPaths(args, pathErrors);
    if (!report('', paths, pathErrors)) process.exit(1);
} else {
    let failed = 0;
    const picked = pickProjects(args, 'check-specs');
    if (!picked.length) console.log(`check-specs: ok — ${noProjects()}: nothing to check`);
    const idOwner = new Map<string, string>();
    const shared: string[] = [];
    for (const p of picked) {
        const set = report(`${p.name}: `, p.documents.map((d) => join(p.specsDir, d)));
        if (!set) {
            failed++;
            continue;
        }
        for (const e of set.merged!.elements) {
            const other = idOwner.get(e.id);
            if (other && other !== p.name) shared.push(`${e.id} (${other}, ${p.name})`);
            else idOwner.set(e.id, p.name);
        }
    }
    if (shared.length) console.warn(`check-specs: warning — ${shared.length} element id(s) in more than one project: ${shared.slice(0, 10).join(', ')}${shared.length > 10 ? ' …' : ''}`);
    if (failed) process.exit(1);
}
