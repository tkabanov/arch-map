// ESLint warnings (the size/complexity limits in eslint.config.js) as a ratchet, like check-tsc.ts does for tsc errors.
// The baseline (quality/lint-warnings-baseline.json) records the number of warnings per `file::rule`. Per function would
// be finer, but a function's identity moves with every rename and line shift; file+rule survives edits to other code and
// still catches the two things that matter: a new warning (a new file::rule key, or a count that grows) fails the check;
// fewer warnings pass with a hint to lower the baseline (--update), so the gain is kept.
// ESLint errors fail the check too (as `npm run lint` does), listed as file:line.
// Usage: node scripts/check-lint-warnings.ts            (check against the baseline)
//        node scripts/check-lint-warnings.ts --update   (record the current counts as the baseline)
//        node scripts/check-lint-warnings.ts --list     (also print every warning, file:line)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { warningKey, eslintRunProblem } from './lib/lint-warnings.ts';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(root, 'quality', 'lint-warnings-baseline.json');
const eslint = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');

interface Message { ruleId: string | null; severity: number; message: string; line: number; column: number }
interface FileResult { filePath: string; messages: Message[] }

const run = spawnSync(process.execPath, [eslint, '.', '--pass-on-unpruned-suppressions', '-f', 'json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.error) throw run.error;
const broken = eslintRunProblem(run.status, run.signal);
if (broken) {
    console.error(run.stderr);
    console.error(`check:warnings: ${broken} — result not trusted, baseline untouched`);
    process.exit(1);
}
let results: FileResult[];
try {
    results = JSON.parse(run.stdout);
} catch {
    console.error(run.stdout + run.stderr);
    console.error('check:warnings: eslint produced no JSON (config error?)');
    process.exit(1);
}

const counts: Record<string, number> = {};
const lines: string[] = [];
let errors = 0;
for (const f of results) {
    const file = relative(root, f.filePath).split(sep).join('/');
    for (const m of f.messages) {
        const where = `${file}:${m.line}:${m.column}  ${m.ruleId ?? 'parse'}  ${m.message}`;
        if (m.severity === 2) {
            errors++;
            console.error(`error    ${where}`);
        } else {
            lines.push(`warning  ${where}`);
            const key = warningKey(root, f.filePath, m.ruleId);
            counts[key] = (counts[key] ?? 0) + 1;
        }
    }
}
const total = lines.length;
const entries = Object.fromEntries(Object.entries(counts).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
if (process.argv.includes('--list')) for (const l of lines) console.log(l);

if (process.argv.includes('--update')) {
    if (errors) {
        console.error(`check:warnings: ${errors} eslint error(s) — fix them before recording a baseline`);
        process.exit(1);
    }
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify({ total, entries }, null, 4) + '\n');
    console.log(`check:warnings: baseline recorded — ${total} warning(s) in ${Object.keys(entries).length} file::rule key(s)`);
    process.exit(0);
}

const base: { total: number; entries: Record<string, number> } = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { total: 0, entries: {} };
let worse = 0;
for (const [key, n] of Object.entries(entries)) {
    const was = base.entries[key] ?? 0;
    if (n <= was) continue;
    worse++;
    console.error(`check:warnings: ${key}: ${n} warning(s), baseline ${was}`);
    const [file, rule] = key.split('::');
    for (const l of lines) if (l.includes(`${file}:`) && l.includes(`  ${rule}  `)) console.error(`  ${l}`);
}
if (errors || worse) {
    if (worse) console.error(`check:warnings: new size/complexity warnings (split the function, or — if the growth is deliberate — \`node scripts/check-lint-warnings.ts --update\`)`);
    process.exit(1);
}
const better = Object.entries(base.entries).some(([key, n]) => (entries[key] ?? 0) < n);
const note = better ? ` — below the baseline ${base.total}: run \`node scripts/check-lint-warnings.ts --update\` to keep the gain` : '';
console.log(`check:warnings: ok — ${total} warning(s), baseline ${base.total}${note}`);
