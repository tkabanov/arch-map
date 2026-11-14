// Architecture rules (.dependency-cruiser.cjs): cruises the core (scripts/, viewer/src/, test/, types/) and the active
// projects dir (env ARCH_MAP_PROJECTS, scripts/lib/projects.ts), whose path the config derives the same way.
// Usage: node scripts/check-arch.ts   (npm run check:arch); exit status of depcruise.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects, projectsDir, noProjects } from './lib/projects.ts';

// canonical, like projectsDir() and the config: one spelling of every path
const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const depcruise = join(root, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const { projects } = loadProjects();
const dirs = ['scripts', 'viewer/src', 'test', 'types'];
if (projects.length) dirs.push(relative(root, projectsDir()) || '.');
else console.log(`check:arch: ${noProjects()} — the core only`);
const r = spawnSync(process.execPath, [depcruise, ...dirs, '--config', '.dependency-cruiser.cjs'], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
