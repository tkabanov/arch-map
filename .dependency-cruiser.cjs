// Architecture rules (code-quality pass 1, docs/code-quality.md): `npm run check:arch` (scripts/check-arch.ts).
// The layers: viewer/src/core/ is the shared pure core (merge, tiers, Path, queries) — plain ESM that runs both in
// Node (scripts/) and in the browser (viewer/); the rest of viewer/src is the three.js + DOM viewer; scripts/ are the
// Node generators and checks; <projects dir>/<p>/ is everything that knows one concrete project (config, generator,
// tests, specs). The projects dir is env ARCH_MAP_PROJECTS (default examples/), resolved as scripts/lib/projects.ts
// projectsDir() does; project code reaches the core only through the package's `exports` (`arch-map/…`).
const { resolve, relative, sep } = require('node:path');
const { existsSync, realpathSync } = require('node:fs');

// canonical, like projectsDir(): depcruise reports resolved targets by their physical path
const real = (p) => (existsSync(p) ? realpathSync(p) : p);
const root = real(__dirname);
const projectsDir = real(process.env.ARCH_MAP_PROJECTS ? resolve(root, process.env.ARCH_MAP_PROJECTS) : resolve(root, 'examples'));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The projects dir as depcruise prints paths: relative to this checkout, `/`-separated, as a regex prefix. */
const P = `^${escapeRe(relative(root, projectsDir).split(sep).join('/'))}/`;
/** What `exports` maps `arch-map/…` to (package.json): the only core files project code may import. */
const PUBLIC_API = '^(scripts/stacks/[^/]+/index\\.ts|scripts/lib/(generator|testing)\\.ts|scripts/check-(specs|boundary)\\.ts|viewer/src/core/index\\.ts|viewer/src/(model|spec-adapter|layout|scenario|envelopes)\\.ts|types/.+\\.ts)$';
// The core's tests may import anything (a project's tests: only the public API). The facet boundary (only spec-adapter.ts and panel.ts
// read `facets`) is a separate check: scripts/check-boundary.ts.
// Type imports (`import type`, `typeof import('…')`) are cruised (tsPreCompilationDeps: true) and show up as dependency
// types `type-only` / `type-import`. The layer rules are about what runs, so they skip those (`dependencyTypesNot`);
// Stack entry boundaries, `generic-no-projects`, `project-no-other-project` and `not-to-unresolvable` count them too.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    forbidden: [
        {
            name: 'core-no-three',
            comment: 'viewer/src/core/ is pure: no three.js (it runs in Node, in the generators and the checks).',
            severity: 'error',
            from: { path: '^viewer/src/core/' },
            to: { path: '(^|/)node_modules/three/', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'core-no-node-builtins',
            comment: 'viewer/src/core/ is pure: no Node built-ins (it runs in the browser).',
            severity: 'error',
            from: { path: '^viewer/src/core/' },
            to: { dependencyTypes: ['core'], dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'core-no-viewer',
            comment: 'viewer/src/core/ imports no viewer module (they touch the DOM and three.js) and nothing outside the core.',
            severity: 'error',
            from: { path: '^viewer/src/core/' },
            to: { pathNot: ['^viewer/src/core/', '(^|/)node_modules/three/'], dependencyTypesNot: ['core', 'type-only', 'type-import'] },
        },
        {
            name: 'scripts-viewer-core-only',
            comment: 'scripts/ (Node) may import from viewer/ only the pure core viewer/src/core/.',
            severity: 'error',
            from: { path: '^scripts/' },
            to: { path: '^viewer/', pathNot: '^viewer/src/core/', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'viewer-no-scripts',
            comment: 'The viewer runs in the browser: it does not import the Node generators and checks.',
            severity: 'error',
            from: { path: '^viewer/' },
            to: { path: '^scripts/', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'viewer-no-node-builtins',
            comment: 'The viewer runs in the browser: no Node built-ins.',
            severity: 'error',
            from: { path: '^viewer/' },
            to: { dependencyTypes: ['core'], dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'generic-no-projects',
            comment: 'scripts/, viewer/src/ and types/ never import the projects dir, not even a type (the import goes the other way; scripts/run.ts spawns <projects dir>/<p>/*.ts as child processes; a project config satisfies a stack config interface of types/stacks/).',
            severity: 'error',
            from: { path: '^(scripts|viewer/src|types)/' },
            to: { path: `${P}.+\\.ts$` },
        },
        {
            name: 'stack-supabase-imports',
            comment: 'The Supabase stack (scripts/stacks/supabase/) imports only itself, scripts/lib/, the pure core and types/ (plus packages and Node built-ins); it takes every id and config value from the project config it is handed.',
            severity: 'error',
            from: { path: '^scripts/stacks/supabase/' },
            to: { path: '^(scripts|viewer|types|test)/', pathNot: '^(scripts/stacks/supabase/|scripts/lib/|viewer/src/core/|types/)' },
        },
        {
            name: 'supabase-shared-imports',
            comment: 'Shared ids, domain assignment and source readers do not depend on Supabase extractors or builders.',
            severity: 'error',
            from: { path: '^scripts/stacks/supabase/(ids|domains|sources)\\.ts$' },
            to: { path: '^scripts/stacks/supabase/', pathNot: '^scripts/stacks/supabase/(ids|domains|sources)\\.ts$', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'supabase-sql-snapshot-imports',
            comment: 'SQL parsing and database snapshots stay below database builders, the JS scanner, Edge Functions and React clients.',
            severity: 'error',
            from: { path: '^scripts/stacks/supabase/(sql|snapshot)\\.ts$' },
            to: { path: '^scripts/stacks/supabase/', pathNot: '^scripts/stacks/supabase/(sql|snapshot|ids|domains|sources)\\.ts$', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'supabase-scanner-imports',
            comment: 'The shared supabase-js scanner does not depend on database builders, SQL, snapshots or its Edge and React consumers.',
            severity: 'error',
            from: { path: '^scripts/stacks/supabase/supabase-js\\.ts$' },
            to: { path: '^scripts/stacks/supabase/', pathNot: '^scripts/stacks/supabase/(supabase-js|ids|domains|sources)\\.ts$', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'supabase-db-imports',
            comment: 'Database builders use SQL, snapshots and shared helpers, never the JS scanner, Edge Functions or React clients.',
            severity: 'error',
            from: { path: '^scripts/stacks/supabase/(db|db-[^/]+)\\.ts$' },
            to: { path: '^scripts/stacks/supabase/', pathNot: '^scripts/stacks/supabase/(db|db-[^/]+|sql|snapshot|ids|domains|sources)\\.ts$', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'supabase-edge-imports',
            comment: 'Edge scanners and builders use their own layer, the shared JS scanner and shared helpers, never database builders or React clients.',
            severity: 'error',
            from: { path: '^scripts/stacks/supabase/(edge|edge-[^/]+)\\.ts$' },
            to: { path: '^scripts/stacks/supabase/', pathNot: '^scripts/stacks/supabase/(edge|edge-[^/]+|supabase-js|ids|domains|sources)\\.ts$', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'supabase-react-client-imports',
            comment: 'React client scanners and builders use their own layer, the shared JS scanner and shared helpers, never database builders or Edge Functions.',
            severity: 'error',
            from: { path: '^scripts/stacks/supabase/(react-client|react-client-[^/]+)\\.ts$' },
            to: { path: '^scripts/stacks/supabase/', pathNot: '^scripts/stacks/supabase/(react-client|react-client-[^/]+|supabase-js|ids|domains|sources)\\.ts$', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'stack-no-other-stack',
            comment: 'A stack (scripts/stacks/<s>/) never imports another stack, not even a type: what stacks share lives in scripts/lib/, viewer/src/core/ or types/.',
            severity: 'error',
            from: { path: '^scripts/stacks/([^/]+)/' },
            to: { path: '^scripts/stacks/', pathNot: '^scripts/stacks/$1/' },
        },
        {
            name: 'project-no-other-project',
            comment: 'A project (<projects dir>/<p>/) imports the core (through arch-map/…) and itself, never another project.',
            severity: 'error',
            from: { path: `${P}([^/]+)/` },
            to: { path: `${P}([^/]+)/`, pathNot: `${P}$1/` },
        },
        {
            name: 'project-core-via-package',
            comment: 'Project code imports the core only by its package name (`arch-map/…`, package.json `exports`), never by a relative path out of the projects dir: the projects dir must work from outside this checkout. This includes type imports.',
            severity: 'error',
            from: { path: P },
            to: { dependencyTypes: ['local'], pathNot: P },
        },
        {
            name: 'project-public-api-only',
            comment: 'Of the core, project code imports only the public entry points (`arch-map/stacks/<s>`, `arch-map/generator`, `arch-map/testing`, `arch-map/core`, `arch-map/viewer/<module>`, `arch-map/types/<file>`), never a stack\'s, the checks\' or the viewer\'s internals. This includes type imports.',
            severity: 'error',
            from: { path: P },
            to: { path: '^(scripts|viewer|types|test|specs)/', pathNot: PUBLIC_API },
        },
        {
            name: 'project-code-no-test-surface',
            comment: 'A project\'s own code (its tests aside) does not import the test surface: `arch-map/testing` (the checks) and `arch-map/viewer/<module>` (the viewer\'s model, for tests over the project\'s specs).',
            severity: 'error',
            from: { path: P, pathNot: `${P}[^/]+/test/` },
            to: { path: '^(scripts/lib/testing\\.ts|viewer/src/(?!core/))', dependencyTypesNot: ['type-only', 'type-import'] },
        },
        {
            name: 'lib-no-stacks',
            comment: 'scripts/lib/ is below the stacks: it imports no stack (a stack imports lib, never the other way).',
            severity: 'error',
            from: { path: '^scripts/lib/' },
            to: { path: '^scripts/stacks/' },
        },
        {
            name: 'stack-nest-isolated',
            comment: 'The Nest stack (scripts/stacks/nest/) imports only scripts/lib/, viewer/src/core/ and types/ (and itself): it names no project and reaches no other stack.',
            severity: 'error',
            from: { path: '^scripts/stacks/nest/' },
            to: { path: '^(scripts|viewer|types|test)/', pathNot: '^(scripts/stacks/nest/|scripts/lib/|viewer/src/core/|types/)' },
        },
        {
            name: 'no-circular',
            comment: 'No import cycles in the code that runs (tests excluded: they may import anything; cycles through type imports are allowed).',
            severity: 'error',
            from: { path: `^(scripts|viewer)/|${P}` },
            to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only', 'type-import'] } },
        },
        {
            name: 'not-to-unresolvable',
            comment: 'Every import resolves to a file or a package.',
            severity: 'error',
            from: {},
            to: { couldNotResolve: true },
        },
        {
            name: 'core-no-packages',
            comment: 'The core uses no package at all (npm packages land in both bundles).',
            severity: 'error',
            from: { path: '^viewer/src/core/' },
            to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'], dependencyTypesNot: ['type-only', 'type-import'] },
        },
    ],
    options: {
        doNotFollow: { path: 'node_modules' },
        exclude: { path: ['^viewer/public/', '^dist/', '^test/fixtures/', `${P}[^/]+/test/fixtures/`, `${P}[^/]+/target/`, `${P}node_modules/`] },
        moduleSystems: ['es6'],
        tsPreCompilationDeps: true,
        enhancedResolveOptions: {
            exportsFields: ['exports'],
            conditionNames: ['import', 'default', 'node'],
            mainFields: ['module', 'main'],
            extensions: ['.js', '.mjs', '.ts', '.json'],
        },
        reporterOptions: { text: { highlightFocused: true } },
    },
};
