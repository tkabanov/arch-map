// The unit tests: the core's own (test/*.test.ts, on fixtures; they need no project) and the tests of every active
// project (<projects dir>/<p>/test/*.test.ts, the projects dir is env ARCH_MAP_PROJECTS), in one `node --test` run.
// Usage: node scripts/test.ts [--core]   (npm test; --core: the core's tests only). Extra arguments go to node --test.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects, noProjects, projectsDir } from './lib/projects.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const coreOnly = args.includes('--core');
const tests = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort().map((f) => join(dir, f)) : []);

const files = tests(join(root, 'test'));
const { projects } = loadProjects();
if (!coreOnly) for (const p of projects) files.push(...tests(join(p.dir, 'test')));
// the projects dir's own tools (<projects dir>/tools/test, when it has them)
if (!coreOnly) files.push(...tests(join(projectsDir(), 'tools', 'test')));
console.log(`test: ${files.length} file(s) — the core's${coreOnly ? '' : projects.length ? `, ${projects.map((p) => p.name).join(', ')}` : ` (${noProjects()})`}`);
const r = spawnSync(process.execPath, ['--test', ...args.filter((a) => a !== '--core'), ...files.map((f) => relative(root, f) || f)], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
