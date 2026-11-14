// The projects directory (env ARCH_MAP_PROJECTS; scripts/lib/projects.ts): the manifests load and agree with the files on
// disk; a bad manifest fails with a message naming it; zero projects is valid; env defaults expand; `npm run gen` with
// no project lists the projects and exits 1; the viewer's choice of project and documents (viewer/src/projects.ts).
// The core's own tests run on the fixture projects directory (test/fixtures/projects/), not on real projects; the
// first test also checks whatever projects directory is active.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects, envValue, rootOf, ProjectsError, projectsDir, DEFAULT_PROJECTS_DIR, PROJECTS_ENV, type Projects } from '../scripts/lib/projects.ts';
import { pick, shortTitle, shortTitles } from '../viewer/src/projects.ts';
import type { ProjectManifest, ViewerManifest, ViewerProject } from '../types/project.ts';

const archDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(archDir, 'test', 'fixtures', 'projects');
const fixture = (): Projects => loadProjects(FIXTURE);

const consistent = ({ index, projects }: Projects): void => {
    assert.deepEqual(projects.map((p) => p.name), index.order);
    if (projects.length) assert.ok(index.default && index.order.includes(index.default));
    for (const p of projects) {
        assert.equal(p.specsDir, join(p.dir, 'specs'));
        for (const d of p.documents) assert.ok(existsSync(join(p.specsDir, d)), `${p.name}: ${d}`);
        for (const o of p.determinism.outputs.filter((f) => !f.endsWith('.meta.json'))) assert.ok(existsSync(join(p.specsDir, o)), `${p.name}: output ${o}`);
        for (const s of [p.generate, ...Object.values(p.snapshots ?? {})]) assert.ok(existsSync(join(p.dir, s.script)), `${p.name}: ${s.script}`);
        for (const g of p.determinism.guard ?? []) assert.ok(existsSync(join(p.dir, g)), `${p.name}: guard ${g}`);
    }
};

test('the manifests load; every document, script, guard and baseline they name exists (fixture and active projects)', () => {
    consistent(fixture());
    assert.deepEqual(fixture().projects.map((p) => p.name), ['fxa', 'fxb']);
    consistent(loadProjects());
});

test('the projects directory: ARCH_MAP_PROJECTS (relative to the checkout or absolute), else examples/; zero projects is valid', () => {
    assert.equal(projectsDir({}), DEFAULT_PROJECTS_DIR);
    assert.equal(projectsDir({ [PROJECTS_ENV]: 'test/fixtures/projects' }), FIXTURE);
    assert.equal(projectsDir({ [PROJECTS_ENV]: FIXTURE }), FIXTURE);
    assert.deepEqual(loadProjects(DEFAULT_PROJECTS_DIR).projects.map((p) => p.name).filter((n) => !existsSync(join(DEFAULT_PROJECTS_DIR, n))), []);
    const dir = mkdtempSync(join(tmpdir(), 'arch-map-none-'));
    try {
        writeFileSync(join(dir, 'index.json'), '{ "order": [] }');
        mkdirSync(join(dir, '.git'));
        mkdirSync(join(dir, 'node_modules'));
        assert.deepEqual(loadProjects(dir), { index: { order: [] }, projects: [] });
        // canonical: a symlink (and macOS's /var → /private/var) resolves to the physical path
        symlinkSync(dir, join(dir, '..', `${basename(dir)}-link`), 'dir');
        try {
            assert.equal(projectsDir({ [PROJECTS_ENV]: join(dir, '..', `${basename(dir)}-link`) }), realpathSync(dir));
        } finally {
            rmSync(join(dir, '..', `${basename(dir)}-link`));
        }
        assert.throws(() => loadProjects(join(dir, 'nope')), (e: unknown) => e instanceof ProjectsError && /the projects directory does not exist/.test(e.problems[0]));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** Copies the fixture projects to a temp dir, lets `mutate` change it, returns the problems loadProjects reports. */
function problemsAfter(mutate: (dir: string) => void): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'arch-map-projects-'));
    try {
        cpSync(FIXTURE, dir, { recursive: true });
        mutate(dir);
        loadProjects(dir);
        return [];
    } catch (err) {
        assert.ok(err instanceof ProjectsError, String(err));
        return err.problems;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
const edit = (dir: string, name: string, change: (m: ProjectManifest) => void): void => {
    const file = join(dir, name, 'project.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    change(m);
    writeFileSync(file, JSON.stringify(m));
};

test('a bad manifest fails naming the file and the problem', () => {
    assert.deepEqual(problemsAfter(() => {}), []);
    const [p1, p2] = fixture().projects;
    const bad = problemsAfter((dir) => edit(dir, p1.name, (m) => m.open.push('nope.json')));
    assert.match(bad.join('\n'), new RegExp(`${p1.name}/project.json: open names "nope.json", which is not in documents`));
    const dup = problemsAfter((dir) => edit(dir, p2.name, (m) => m.documents.push(p1.documents[0])));
    assert.match(dup.join('\n'), /document name ".*" is in both .* and .*: document names must be unique across projects/);
    const field = problemsAfter((dir) => edit(dir, p1.name, (m) => Object.assign(m, { extra: 1 })));
    assert.match(field.join('\n'), /must NOT have additional properties "extra"/);
    const undeclared = problemsAfter((dir) => edit(dir, p1.name, (m) => (m.generate.needs = ['NOT_DECLARED'])));
    assert.match(undeclared.join('\n'), /"NOT_DECLARED" is not declared in env/);
    const unlisted = problemsAfter((dir) => {
        const file = join(dir, 'index.json');
        const idx = JSON.parse(readFileSync(file, 'utf8'));
        idx.order = idx.order.filter((n: string) => n !== p2.name);
        writeFileSync(file, JSON.stringify(idx));
    });
    assert.match(unlisted.join('\n'), new RegExp(`project "${p2.name}" is not in order`));
    const noDefault = problemsAfter((dir) => writeFileSync(join(dir, 'index.json'), JSON.stringify({ order: [p1.name, p2.name] })));
    assert.match(noDefault.join('\n'), /no default \(needed when order names a project\)/);
});

test('env defaults expand other variables; a root that is not there says why', () => {
    const m: ProjectManifest = {
        ...fixture().projects[0],
        env: { A_ROOT: { about: 'a', mustHave: 'package.json' }, B_ROOT: { about: 'b', default: '${A_ROOT}/../b' } },
    };
    assert.equal(envValue(m, 'B_ROOT', { A_ROOT: '/x/a' }), '/x/a/../b');
    assert.equal(envValue(m, 'B_ROOT', { A_ROOT: '/x/a', B_ROOT: '/y' }), '/y');
    assert.equal(envValue(m, 'B_ROOT', {}), undefined);
    const save = process.env.A_ROOT;
    try {
        delete process.env.A_ROOT;
        assert.match((rootOf(m, 'A_ROOT') as { problem: string }).problem, /A_ROOT is not set/);
        process.env.A_ROOT = archDir;
        assert.deepEqual(rootOf(m, 'A_ROOT'), { root: archDir });
        process.env.A_ROOT = join(archDir, 'specs');
        assert.match((rootOf(m, 'A_ROOT') as { problem: string }).problem, /has no package\.json/);
    } finally {
        if (save === undefined) delete process.env.A_ROOT;
        else process.env.A_ROOT = save;
    }
});

const runTs = (projects: string, args: string[]) =>
    spawnSync(process.execPath, [join(archDir, 'scripts', 'run.ts'), ...args], { cwd: archDir, encoding: 'utf8', env: { ...process.env, [PROJECTS_ENV]: projects } });

test('gen with no project lists the projects and exits 1; with no projects it says so', () => {
    const r = runTs(FIXTURE, ['gen']);
    assert.equal(r.status, 1);
    for (const p of fixture().projects) assert.match(r.stderr, new RegExp(`^  ${p.name} `, 'm'));
    const dir = mkdtempSync(join(tmpdir(), 'arch-map-empty-'));
    try {
        writeFileSync(join(dir, 'index.json'), '{ "order": [] }');
        const none = runTs(dir, ['gen', 'fxa']);
        assert.equal(none.status, 1);
        assert.match(none.stderr, /no projects in /);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------- the viewer's choice of project and documents (viewer/src/projects.ts) ----------
const M: ViewerManifest = {
    default: 'a',
    projects: [
        { name: 'a', title: 'A', documents: ['a1.json', 'a2.json', 'shared-overlay.json'], open: ['a1.json', 'a2.json'] },
        { name: 'b', title: 'B', documents: ['b1.json', 'b2.json'], open: ['b1.json'] },
    ],
};
const ok = (search: string) => {
    const r = pick(M, search);
    assert.ok(!('error' in r), JSON.stringify(r));
    return { project: r.project.name, documents: r.documents, base: r.base };
};
const err = (search: string) => {
    const r = pick(M, search);
    assert.ok('error' in r, JSON.stringify(r));
    return r;
};

test('viewer pick: default, ?project=, ?docs= with and without ?project', () => {
    assert.deepEqual(ok(''), { project: 'a', documents: ['a1.json', 'a2.json'], base: 'specs/a/' });
    assert.deepEqual(ok('?project=b'), { project: 'b', documents: ['b1.json'], base: 'specs/b/' });
    assert.deepEqual(ok('?project=b&docs=b2.json,b1.json'), { project: 'b', documents: ['b2.json', 'b1.json'], base: 'specs/b/' });
    assert.deepEqual(ok('?docs=a2.json'), { project: 'a', documents: ['a2.json'], base: 'specs/a/' });
    // a name outside the default project: the one project that has every name
    assert.deepEqual(ok('?docs=b2.json, b1.json'), { project: 'b', documents: ['b2.json', 'b1.json'], base: 'specs/b/' });
    assert.deepEqual(ok('?nofacets=1&docs=b1.json'), { project: 'b', documents: ['b1.json'], base: 'specs/b/' });
});

test('viewer pick: unknown project, foreign or unknown documents, documents of two projects', () => {
    const u = err('?project=zz');
    assert.match(u.error, /Unknown project "zz"/);
    assert.deepEqual(u.lines, []);
    assert.deepEqual(u.projects?.map((p) => [p.name, p.title]), [['a', 'A'], ['b', 'B']], 'the error page links to every project, each title once');
    assert.match(err('?project=a&docs=b1.json').error, /not in a/);
    const missing = err('?docs=nope.json');
    assert.match(missing.error, /no project has/);
    assert.deepEqual(missing.lines, ['nope.json']);
    assert.equal(missing.projects?.length, 2);
    const two = err('?docs=a1.json,b1.json');
    assert.match(two.error, /more than one project: add \?project=/);
    assert.deepEqual(two.lines, ['a1.json: a', 'b1.json: b']);
});

test('viewer pick on a loaded manifest: the open set of every project resolves to it by ?docs=; no projects is an error', () => {
    const { index, projects } = fixture();
    const real: ViewerManifest = { default: index.default ?? null, projects: projects.map(({ name, title, documents, open }) => ({ name, title, documents, open })) };
    const at = (s: string) => {
        const r = pick(real, s);
        assert.ok(!('error' in r), JSON.stringify(r));
        return r.project.name;
    };
    assert.equal(at(''), index.default);
    for (const p of projects) {
        assert.equal(at(`?project=${p.name}`), p.name);
        assert.equal(at(`?docs=${p.open.join(',')}`), p.name);
    }
    const none = pick({ default: null, projects: [] }, '');
    assert.ok('error' in none && /No projects/.test(none.error));
});

test('the project switcher shows the title before " — " (the page title keeps the long one)', () => {
    const p = (title: string) => ({ name: 'x', title }) as ViewerProject;
    assert.equal(shortTitle(p('Orders — NestJS backend, Vue fronts, client layer')), 'Orders');
    assert.equal(shortTitle(p('Tasks Supabase')), 'Tasks Supabase');
    assert.equal(shortTitle(p(' — odd')), 'x');
});

test('colliding short titles keep the full title (or the name when the titles are equal too)', () => {
    const p = (name: string, title: string) => ({ name, title }) as ViewerProject;
    assert.deepEqual(shortTitles([p('a', 'Tasks — Supabase'), p('b', 'Tasks — Nest'), p('c', 'Events')]), ['Tasks — Supabase', 'Tasks — Nest', 'Events']);
    assert.deepEqual(shortTitles([p('a', 'Tasks — X'), p('b', 'Tasks — X')]), ['Tasks — X (a)', 'Tasks — X (b)']);
    assert.deepEqual(shortTitles([p('a', 'Orders — NestJS'), p('b', 'Billing')]), ['Orders', 'Billing']);
});
