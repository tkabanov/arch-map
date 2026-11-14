// The per-project commands (<projects dir>/<name>/project.json; the projects dir is env ARCH_MAP_PROJECTS):
//   gen <project>                          generate → check that project → publish the specs for the viewer
//   snapshot <project> [<kind>] [args…]    refresh a committed input (the kind may be left out when there is one)
// npm: `npm run gen -- <project>`, `npm run snapshot -- <project> <kind> [args…]`. With no project it lists the projects and
// exits 1. Env comes from .env.local (the npm scripts pass --env-file-if-exists) and is handed to the project scripts.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects, envValue, noProjects } from './lib/projects.ts';
import type { Project, ProjectScript } from '../types/project.ts';

const archDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const [command, name, ...rest] = process.argv.slice(2);
const { projects } = loadProjects();

const usage = (problem: string): never => {
    console.error(`run: ${problem}`);
    console.error('usage: npm run gen -- <project> | npm run snapshot -- <project> [<kind>] [args…]');
    if (!projects.length) console.error(`  ${noProjects()}`);
    for (const p of projects) {
        const kinds = Object.keys(p.snapshots ?? {});
        console.error(`  ${p.name.padEnd(12)} ${p.title}${kinds.length ? ` (snapshots: ${kinds.join(', ')})` : ''}`);
    }
    process.exit(1);
};

/** Runs a node script; exits with its status when it fails. */
const node = (script: string, args: string[]): void => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: archDir, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
};

const runScript = (p: Project, s: ProjectScript, args: string[]): void => {
    const unset = (s.needs ?? []).filter((v) => !envValue(p, v));
    if (unset.length) {
        for (const v of unset) console.error(`run: ${p.name} needs ${v} — ${p.env[v].about}. Put ${v}=… into .env.local (see .env.example).`);
        process.exit(1);
    }
    node(join(p.dir, s.script), args.length ? args : (s.args ?? []));
};

if (command !== 'gen' && command !== 'snapshot') usage(`unknown command "${command ?? ''}"`);
if (!name) usage('name a project');
const project = projects.find((p) => p.name === name) ?? usage(`unknown project "${name}"`);

if (command === 'gen') {
    if (rest.length) usage(`gen takes no arguments after the project (got ${rest.join(' ')})`);
    runScript(project, project.generate, []);
    node(join(archDir, 'scripts', 'check-specs.ts'), [project.name]);
    node(join(archDir, 'scripts', 'publish-specs.ts'), []);
} else {
    const kinds = Object.keys(project.snapshots ?? {});
    if (!kinds.length) usage(`${project.name} has no snapshots`);
    const [kind, args] = kinds.includes(rest[0]) ? [rest[0], rest.slice(1)] : kinds.length === 1 ? [kinds[0], rest] : usage(`${project.name}: name the snapshot (${kinds.join(', ')})`);
    runScript(project, project.snapshots![kind], args);
}
