// The projects: the projects directory (env ARCH_MAP_PROJECTS; default examples/ of this repo) holds index.json and
// one self-contained folder per project (<dir>/<name>/project.json, its code, sources, tests and its spec documents in
// specs/; schema specs/schema/project.schema.json). Loaded, validated and resolved here, the only reader of the
// manifests. Generic scripts (check-*, publish-specs, run.ts) take every project fact from here and name no project
// themselves. Zero projects (an index with an empty `order`) is a valid state: the scripts say so and do nothing.
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { SPECS_DIR } from './spec-io.ts';
import type { Project, ProjectIndex, ProjectManifest } from '../../types/project.ts';

const archDir = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
/** The env variable that names the projects directory. */
export const PROJECTS_ENV = 'ARCH_MAP_PROJECTS';
/** The projects directory when PROJECTS_ENV is not set. */
export const DEFAULT_PROJECTS_DIR = join(archDir, 'examples');
export const PROJECT_SCHEMA_PATH = join(SPECS_DIR, 'schema', 'project.schema.json');

/**
 * The projects directory: PROJECTS_ENV (absolute, or relative to the arch-map checkout) or the default. Read at each
 * call. Canonical (symlinks resolved, as `realpath`) when it exists, so every tool sees one spelling of it — depcruise
 * and Node resolve imports to physical paths (on macOS the temp dir /var is /private/var). .dependency-cruiser.cjs does
 * the same.
 */
export function projectsDir(env: NodeJS.ProcessEnv = process.env): string {
    const v = env[PROJECTS_ENV];
    const dir = v ? resolve(archDir, v) : DEFAULT_PROJECTS_DIR;
    return existsSync(dir) ? realpathSync(dir) : dir;
}

/** The folder a project's spec documents live in: <project dir>/specs/ (its contracts in contracts/ under it). */
export const specsDirOf = (projectDir: string): string => join(projectDir, 'specs');

export class ProjectsError extends Error {
    declare problems: string[];
    constructor(problems: string[]) {
        super(`projects: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
        this.problems = problems;
    }
}

export interface Projects {
    index: ProjectIndex;
    /** in `index.order` */
    projects: Project[];
}

/** Reads and checks every manifest of the projects directory. Throws ProjectsError listing every problem. */
export function loadProjects(dir = projectsDir()): Projects {
    if (!existsSync(dir) || !statSync(dir).isDirectory())
        throw new ProjectsError([`${dir}: the projects directory does not exist (${PROJECTS_ENV}=${process.env[PROJECTS_ENV] ?? '(not set)'})`]);
    const ajv = new Ajv2020({ allErrors: true });
    ajv.addSchema(JSON.parse(readFileSync(PROJECT_SCHEMA_PATH, 'utf8')));
    const checkProject = ajv.getSchema('arch-map:project:1')!;
    const checkIndex = ajv.getSchema('arch-map:project:1#/$defs/index')!;
    const problems: string[] = [];
    const read = (file: string): unknown => {
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        } catch (err) {
            problems.push(`${file}: ${(err as Error).message}`);
            return null;
        }
    };
    const schemaErrors = (file: string, errors: typeof checkProject.errors): void => {
        for (const e of errors ?? []) problems.push(`${file}: ${e.instancePath || '/'} ${e.message}${e.params && 'additionalProperty' in e.params ? ` "${e.params.additionalProperty}"` : ''}`);
    };

    const indexFile = join(dir, 'index.json');
    const index = read(indexFile) as ProjectIndex | null;
    if (index && !checkIndex(index)) schemaErrors(indexFile, checkIndex.errors);
    // a project is a folder; dot folders (.git), node_modules (a projects repo's own install) and tools/ (the projects dir's own
    // tooling, with tools/test run by `npm test`) are not
    const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'tools').map((d) => d.name).sort();
    const projects: Project[] = [];
    for (const name of folders) {
        const file = join(dir, name, 'project.json');
        if (!existsSync(file)) {
            problems.push(`${join(dir, name)}: no project.json`);
            continue;
        }
        const m = read(file) as ProjectManifest | null;
        if (!m) continue;
        if (!checkProject(m)) {
            schemaErrors(file, checkProject.errors);
            continue;
        }
        problems.push(...manifestProblems(m, file, name));
        projects.push({ ...m, dir: join(dir, name), specsDir: specsDirOf(join(dir, name)) });
    }
    if (index) {
        for (const n of index.order) if (!folders.includes(n)) problems.push(`${indexFile}: order names "${n}", which has no folder`);
        for (const n of folders) if (!index.order.includes(n)) problems.push(`${indexFile}: project "${n}" is not in order`);
        if (index.default === undefined ? index.order.length > 0 : !index.order.includes(index.default))
            problems.push(`${indexFile}: ${index.default === undefined ? 'no default (needed when order names a project)' : `default "${index.default}" is not in order`}`);
    }
    // ?docs= finds a document's project by its name: names are unique across projects
    const owner = new Map<string, string>();
    for (const p of projects)
        for (const d of p.documents) {
            if (owner.has(d)) problems.push(`document name "${d}" is in both ${owner.get(d)} and ${p.name}: document names must be unique across projects`);
            else owner.set(d, p.name);
        }
    if (problems.length || !index) throw new ProjectsError(problems);
    const rank = (p: Project) => index.order.indexOf(p.name);
    return { index, projects: projects.sort((a, b) => rank(a) - rank(b)) };
}

/** What the schema cannot say about one manifest. */
function manifestProblems(m: ProjectManifest, file: string, folder: string): string[] {
    const problems: string[] = [];
    if (m.name !== folder) problems.push(`${file}: name "${m.name}" is not the folder name "${folder}"`);
    for (const d of m.open) if (!m.documents.includes(d)) problems.push(`${file}: open names "${d}", which is not in documents`);
    const used = [m.generate.needs, ...Object.values(m.snapshots ?? {}).map((s) => s.needs), m.determinism.roots, m.determinism.withoutEnv].flatMap((l) => l ?? []);
    for (const v of used) if (!m.env[v]) problems.push(`${file}: "${v}" is not declared in env`);
    for (const o of m.determinism.withoutRunTime ?? []) if (!m.determinism.outputs.includes(o)) problems.push(`${file}: withoutRunTime names "${o}", which is not in outputs`);
    return problems;
}

/**
 * The projects named in `args` (all of them when none is named). Unknown names: prints the list and exits 1.
 * `what` names the caller in the message.
 */
export function pickProjects(args: string[], what: string): Project[] {
    const { projects } = loadProjects();
    if (!args.length) return projects;
    if (!projects.length) {
        console.error(`${what}: ${noProjects()} — cannot pick ${args.join(', ')}`);
        process.exit(1);
    }
    const unknown = args.filter((a) => !projects.some((p) => p.name === a));
    if (unknown.length) {
        console.error(`${what}: unknown project(s) ${unknown.join(', ')} — the projects: ${projects.map((p) => p.name).join(', ')}`);
        process.exit(1);
    }
    return args.map((a) => projects.find((p) => p.name === a)!);
}

/** The message for a projects directory with no project in it. */
export const noProjects = (dir = projectsDir()): string => `no projects in ${dir} (set ${PROJECTS_ENV} in .env.local to a projects directory)`;

/** True when every argument is a project name (scripts that also take document paths tell the two apart with this). */
export const areProjectNames = (args: string[]): boolean => {
    if (!args.length) return false;
    const names = new Set(loadProjects().projects.map((p) => p.name));
    return args.every((a) => names.has(a));
};

/** A project env variable's value: the environment, else its declared default with `${OTHER}` expanded; undefined when neither. */
export function envValue(project: ProjectManifest, name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (env[name]) return env[name];
    const def = project.env[name]?.default;
    if (def === undefined) return undefined;
    let missing = false;
    const value = def.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, v: string) => {
        const x = v === name ? undefined : envValue(project, v, env);
        if (x === undefined) missing = true;
        return x ?? '';
    });
    return missing ? undefined : value;
}

/**
 * A target checkout named by an env variable: its path, or a message saying why it cannot be used (not set, not
 * there, or without the declared `mustHave`).
 */
export function rootOf(project: ProjectManifest, name: string): { root: string } | { problem: string } {
    const root = envValue(project, name);
    if (!root) return { problem: `${name} is not set. Put ${name}=… into .env.local (${project.env[name]?.about ?? 'see .env.example'}).` };
    const must = project.env[name]?.mustHave;
    if (!existsSync(root)) return { problem: `${name}=${root} does not exist` };
    if (must && !existsSync(join(root, must))) return { problem: `${name}=${root} has no ${must}` };
    return { root };
}

/** The documents of the named projects (default: every project, in `order`) as one set — wider than any one project: for tests over all the data. */
export function allDocumentPaths(names?: string[]): string[] {
    const { projects } = loadProjects();
    return (names ?? projects.map((p) => p.name)).flatMap((n) => {
        const p = projects.find((x) => x.name === n);
        if (!p) throw new ProjectsError([`unknown project "${n}"`]);
        return p.documents.map((d) => join(p.specsDir, d));
    });
}
