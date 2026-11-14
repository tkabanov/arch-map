// Every check that runs from this checkout alone, one after another; a failure does not stop the rest.
// Not included: check:determinism — it regenerates from the external checkouts (the projects' env roots, see <projects dir>/<name>/project.json).
// Usage: node scripts/check-all.ts          (npm run check:all); exit 1 if any check fails.
//        node scripts/check-all.ts --fast   (npm run check:fast): only the static checks (~10 s, no test/generation runs).
import { spawnSync } from 'node:child_process';

const FAST = ['check:types', 'check:tsc', 'lint', 'check:warnings', 'check:arch', 'check:neutral'];
const CHECKS = ['test', 'check', 'check:boundary', ...FAST];
const fast = process.argv.includes('--fast');
const label = fast ? 'check:fast' : 'check:all';
const list = fast ? FAST : CHECKS;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];
for (const name of list) {
    const t0 = Date.now();
    console.log(`\n── npm run ${name}`);
    const r = spawnSync(npm, ['run', '--silent', name], { stdio: 'inherit' });
    results.push({ name, ok: r.status === 0, s: ((Date.now() - t0) / 1000).toFixed(1) });
}
console.log(`\n${label}:`);
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(15)} ${r.s}s`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${label}: ${failed.length} of ${results.length} failed` : `${label}: ok — ${results.length} checks${fast ? ' (static only; npm run check:all runs the rest)' : ' (check:determinism not included: it needs the external checkouts)'}`);
process.exit(failed.length ? 1 : 0);
