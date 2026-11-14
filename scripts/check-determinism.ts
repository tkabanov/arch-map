// Determinism and read-only target (AD-10), per project (<projects dir>/<name>/project.json#determinism): runs
// the project's generator twice; its `outputs` (documents, unresolved reports, contracts, meta) must be byte-identical
// between the runs (`withoutRunTime` ones compared without generatedAt / durationMs), and `git status` of each target
// checkout in `roots` (with its submodules) must be the same before and after (compared with itself, not with clean:
// the target may be dirty already). The first root is required; the others are checked when they exist. `withoutEnv`
// is removed from the generator's environment (e.g. a database access: generation never reaches the database); every
// `guard` folder (the committed snapshots the generator reads) must be unchanged afterwards.
// Usage: npm run check:determinism [-- <project> ...]
//   default: every project whose first root is set (a project with no roots always runs); a named project whose
//   root is not set fails.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickProjects, rootOf, noProjects } from './lib/projects.ts';
import type { Project } from '../types/project.ts';

const archDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const withoutRunTime = (buf: Buffer): Buffer => {
    const { generatedAt: _g, durationMs: _d, ...rest } = JSON.parse(buf.toString('utf8'));
    return Buffer.from(JSON.stringify(rest));
};
const hashDir = (dir: string): string =>
    readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        .map((entry) => {
            const path = join(dir, entry.name);
            return `${entry.name} ${entry.isDirectory() ? hashDir(path) : createHash('sha256').update(readFileSync(path)).digest('hex')}`;
        }).join('\n');
const git = (root: string, args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

const named = process.argv.slice(2);
let bad = 0;
let ran = 0;
const picked = pickProjects(named, 'check-determinism');
for (const p of picked) {
    const [first, ...others] = p.determinism.roots;
    const main = first ? rootOf(p, first) : null;
    if (main && 'problem' in main) {
        if (named.length) {
            console.error(`check-determinism: ${p.name}: ${main.problem}`);
            bad++;
        } else console.log(`${p.name}: skipped — ${main.problem}`);
        continue;
    }
    ran++;
    bad += determinism(p, main?.root ?? null, others);
}
if (bad) {
    console.error(`check-determinism: ${bad} failure(s)`);
    process.exit(1);
}
if (!ran) {
    console.error(`check-determinism: no project ran (${picked.length ? 'set the roots in .env.local' : noProjects()})`);
    process.exit(1);
}
console.log('check-determinism: ok');

function determinism(p: Project, root: string | null, otherRoots: string[]): number {
    const d = p.determinism;
    let failures = 0;
    // the other target checkouts (e.g. a client app's own repo): read only too, when they exist
    const extra = otherRoots.map((v) => rootOf(p, v)).flatMap((r) => ('root' in r && existsSync(join(r.root, '.git')) ? [r.root] : []));
    const targetStatus = (): string =>
        !root ? '' :
        git(root, ['status', '--porcelain', '--ignore-submodules=none']) +
        git(root, ['submodule', 'foreach', '--quiet', '--recursive', 'echo "== $sm_path $(git rev-parse HEAD)"; git status --porcelain']) +
        extra.map((r) => `== ${r} ${git(r, ['rev-parse', 'HEAD']).trim()}\n${git(r, ['status', '--porcelain'])}`).join('');
    const env = { ...process.env };
    for (const v of d.withoutEnv ?? []) delete env[v];
    const script = join(p.dir, p.generate.script);
    const generate = (): Record<string, Buffer> => {
        execFileSync(process.execPath, [script], { cwd: archDir, env, stdio: ['ignore', 'ignore', 'inherit'] });
        return Object.fromEntries(d.outputs.map((f) => [f, readFileSync(join(p.specsDir, f))]));
    };
    const guards = (d.guard ?? []).map((g) => join(p.dir, g));
    const guardState = () => guards.map(hashDir);

    console.log(`${p.name} (${relative(process.cwd(), script)}):`);
    const before = targetStatus();
    const guardBefore = guardState();
    const first = generate();
    const second = generate();
    const after = targetStatus();

    for (const f of d.outputs) {
        const runTime = d.withoutRunTime?.includes(f);
        const norm = runTime ? withoutRunTime : (b: Buffer) => b;
        const same = norm(first[f]).equals(norm(second[f]));
        console.log(`  ${f}: ${first[f].length} bytes, runs ${same ? 'identical' : 'DIFFER'}${runTime ? ' (without run time)' : ''}`);
        if (!same) failures++;
    }
    if (root) console.log(`  target git status (${before.split('\n').filter(Boolean).length} lines incl. submodule headers): ${before === after ? 'unchanged' : 'CHANGED'}`);
    if (before !== after) {
        failures++;
        console.error(`--- before\n${before}--- after\n${after}`);
    }
    const guardAfter = guardState();
    guards.forEach((g, i) => {
        const same = guardBefore[i] === guardAfter[i];
        console.log(`  snapshot ${relative(process.cwd(), g)}/: ${same ? 'unchanged' : 'CHANGED'}`);
        if (!same) failures++;
    });
    return failures;
}
