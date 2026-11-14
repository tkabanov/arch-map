// Type check (tsconfig.json: the Node side + the pure core; tsconfig.viewer.json: the viewer's `.ts` with the DOM;
// test/browser/tsconfig.json: the browser checks, Node + the DOM inside page.evaluate; <projects dir>/tsconfig.json when
// the active projects dir (env ARCH_MAP_PROJECTS) has one: the projects' code) as a
// ratchet. Both `.ts` (migrated, strict, 0 errors is the goal) and the not-yet-migrated `.js` (checkJs) count:
// the check fails only when the number of errors grows over the recorded baseline (quality/tsc-baseline.json). A
// diagnostic both projects report (the core is in both) counts once. Files that got worse are listed; fixing errors is
// always fine — lower the baseline with --update so the gain is kept.
// Usage: node scripts/check-tsc.ts            (check against the baseline)
//        node scripts/check-tsc.ts --update   (record the current counts as the baseline)
//        node scripts/check-tsc.ts --list     (also print every error)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectsDir } from './lib/projects.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(root, 'quality', 'tsc-baseline.json');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const PROJECTS = ['tsconfig.json', 'tsconfig.viewer.json', 'test/browser/tsconfig.json'];
const projectsConfig = join(projectsDir(), 'tsconfig.json');
if (existsSync(projectsConfig)) PROJECTS.push(relative(root, projectsConfig));
const lines: string[] = [];
for (const project of PROJECTS) {
    const run = spawnSync(process.execPath, [tsc, '-p', join(root, project), '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
    if (run.error) throw run.error;
    const own = run.stdout.split('\n').filter((l) => / error TS\d+:/.test(l));
    if (run.status !== 0 && !own.length) {
        // tsc failed without diagnostics on files: a config problem, not type errors
        console.error(run.stdout + run.stderr);
        console.error(`check:tsc: tsc -p ${project} failed without file diagnostics (config error?)`);
        process.exit(1);
    }
    for (const l of own) if (!lines.includes(l)) lines.push(l);
}
const byFile: Record<string, number> = {};
const byCode: Record<string, number> = {};
for (const l of lines) {
    const file = l.slice(0, l.indexOf('('));
    const code = l.match(/error (TS\d+):/)![1]; // the lines were filtered on it
    byFile[file] = (byFile[file] ?? 0) + 1;
    byCode[code] = (byCode[code] ?? 0) + 1;
}
const sortDesc = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
const current = { total: lines.length, files: sortDesc(byFile), codes: sortDesc(byCode) };

if (process.argv.includes('--list')) for (const l of lines) console.log(l);

if (process.argv.includes('--update')) {
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify(current, null, 4) + '\n');
    console.log(`check:tsc: baseline recorded — ${current.total} error(s) in ${Object.keys(byFile).length} file(s)`);
    process.exit(0);
}

const base: { total: number; files: Record<string, number> } = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { total: 0, files: {} };
const worse = Object.entries(byFile).filter(([f, n]) => n > (base.files[f] ?? 0));
for (const [f, n] of worse) console.error(`check:tsc: ${f}: ${n} error(s), baseline ${base.files[f] ?? 0}`);
if (current.total > base.total) {
    console.error(`check:tsc: ${current.total} error(s) > baseline ${base.total} — new type errors (see the files above; \`node scripts/check-tsc.ts --list\`)`);
    process.exit(1);
}
const note = current.total < base.total ? ` — below the baseline ${base.total}: run \`node scripts/check-tsc.ts --update\` to keep the gain` : '';
console.log(`check:tsc: ok — ${current.total} error(s) in ${Object.keys(byFile).length} file(s), baseline ${base.total}${note}`);
