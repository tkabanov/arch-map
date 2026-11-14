// Builds the publishable package @arch-map/viewer in packages/viewer/ (docs/embedding.md):
//   dist/index.js, element.js, react.js      ES modules (three a dependency, react an optional peer: both imported, not bundled)
//   dist/arch-map.iife.js                    one script, three bundled, the global `ArchMap` (no source map: it would carry three's sources)
//   dist/index.d.ts, element.d.ts, react.d.ts and dist/types/   the declarations (tsconfig.lib.json), only the files the entries reach
//   dist/fonts.css + dist/fonts/             the bundled fonts, .woff2 only (@font-face must be on the page, not in the map's shadow root)
//   schema/                                  the JSON schemas of the spec format (specs/schema/)
//   LICENSE                                  the repository's
// Checks on the way: the package's major version is the spec schema's major, the ES modules import nothing but three
// and react, every file the exports name is there.
// Usage: node scripts/build-lib.ts           (npm run lib:build; `prepack`). Logs go to stderr: `npm pack --json` stays JSON.
//        node scripts/build-lib.ts --pack    (npm run lib:pack; the embed browser check runs it): build, then `npm pack --dry-run`
//                                            lists only the allowed files, and the license notices are the originals
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyNotices, fontImports, licenseOf, noticeName, noticePackages } from './lib/notices.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'packages', 'viewer');
const dist = join(pkgDir, 'dist');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function run(cmd: string, args: string[], cwd = root): string {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) {
        process.stderr.write(r.stdout ?? '');
        throw new Error(`build-lib: ${[cmd, ...args].join(' ')} failed (${r.status})`);
    }
    return r.stdout;
}
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const noticePath = (pkg: string): string => `dist/licenses/${noticeName(pkg)}`;

/** Keep each bundled dependency's original copyright and license text in the package. */
function notices(): void {
    copyNotices(join(dist, 'licenses'));
}

/** The notices in the package are the originals, and the script carries three's license in its banner. */
function checkNotices(): void {
    for (const pkg of noticePackages()) {
        const original = licenseOf(pkg);
        if (readFileSync(join(pkgDir, noticePath(pkg)), 'utf8') !== original) throw new Error(`build-lib: ${noticePath(pkg)} is not ${pkg}'s LICENSE`);
    }
    const three = readFileSync(join(root, 'node_modules', 'three', 'LICENSE'), 'utf8');
    if (!readFileSync(join(dist, 'arch-map.iife.js'), 'utf8').includes(three)) throw new Error('build-lib: dist/arch-map.iife.js lacks three\'s license');
}

/** The package version's major is the spec schema's major (SCHEMA_MAJOR, viewer/src/spec-adapter.ts). */
function checkVersion(): string {
    const major = /SCHEMA_MAJOR = '(\d+)'/.exec(readFileSync(join(root, 'viewer/src/spec-adapter.ts'), 'utf8'))?.[1];
    const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string };
    if (!major || version.split('.')[0] !== major) throw new Error(`build-lib: packages/viewer version ${version} must have the spec schema's major ${major}`);
    return version;
}

/** The declarations: emitted with the repository's layout, `.ts` specifiers made `.js`, short entry files beside them. */
function declarations(): void {
    run(process.execPath, [tsc, '-p', 'tsconfig.lib.json']);
    const types = join(dist, 'types');
    mkdirSync(join(types, 'types'), { recursive: true });
    copyFileSync(join(root, 'types', 'spec.d.ts'), join(types, 'types', 'spec.d.ts'));
    for (const f of walk(types).filter((x) => x.endsWith('.d.ts'))) {
        const text = readFileSync(f, 'utf8').replace(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)(?:\.d)?\.ts(['"])/g, '$1$2.js$3');
        writeFileSync(f, text);
    }
    for (const entry of ['index', 'element', 'react']) {
        writeFileSync(join(dist, `${entry}.d.ts`), `export * from './types/viewer/src/${entry}.js';\n`);
    }
    pruneDeclarations(types);
}

/** Removes the declaration files no entry reaches (tsc emits one for every module of the viewer the entries import). */
function pruneDeclarations(types: string): void {
    const seen = new Set<string>();
    const visit = (file: string): void => {
        if (seen.has(file) || !existsSync(file)) return;
        seen.add(file);
        for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)\.js['"]/g)) visit(join(dirname(file), `${m[1]}.d.ts`));
    };
    for (const entry of ['index', 'element', 'react']) visit(join(dist, `${entry}.d.ts`));
    for (const f of walk(types)) if (!seen.has(f)) rmSync(f);
    for (const d of walk(types).map(dirname)) if (!readdirSync(d).length) rmSync(d, { recursive: true });
}

/** fonts.css: the @font-face rules of the fonts viewer/src/fonts.ts imports, their files under dist/fonts/. */
function fonts(): void {
    const require = createRequire(join(root, 'package.json'));
    const imports = fontImports();
    mkdirSync(join(dist, 'fonts'), { recursive: true });
    const css: string[] = ['/* @arch-map/viewer: the fonts of the map (IBM Plex Sans, Sans Condensed, Mono; Manrope and JetBrains Mono for themes). Import this file on the page. */'];
    for (const spec of imports) {
        const file = require.resolve(spec);
        // .woff2 only: every browser with WebGL 2 reads it (the .woff fallbacks doubled the fonts' size)
        const text = readFileSync(file, 'utf8').replace(/,\s*url\(\.\/files\/[^)]+\.woff\)\s*format\('woff'\)/g, '').replace(/url\(\.\/files\/([^)]+)\)/g, (_m, name: string) => {
            copyFileSync(join(dirname(file), 'files', name), join(dist, 'fonts', name));
            return `url(./fonts/${name})`;
        });
        if (/\.woff\)/.test(text)) throw new Error(`build-lib: ${spec} still names a .woff file`);
        css.push(text.trim());
    }
    writeFileSync(join(dist, 'fonts.css'), css.join('\n') + '\n');
}

/** The ES modules import nothing but each other, three and react (no generator, no scripts/, no Node). */
function checkImports(): void {
    for (const f of readdirSync(dist).filter((x) => x.endsWith('.js') && !x.includes('iife'))) {
        const text = readFileSync(join(dist, f), 'utf8');
        // `import … from 'x'`, `export … from 'x'`, a bare side-effect `import 'x'`, and `import('x')`
        const bare = [...text.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)]
            .map((m) => m[1] ?? m[2] ?? m[3])
            .filter((s) => !s.startsWith('./') && !/^(three|react)(\/|$)/.test(s));
        if (bare.length) throw new Error(`build-lib: dist/${f} imports ${[...new Set(bare)].join(', ')}`);
    }
}

function build(): void {
    const version = checkVersion();
    rmSync(dist, { recursive: true, force: true });
    for (const mode of ['esm', 'iife']) run(process.execPath, [vite, 'build', '--config', 'viewer/vite.lib.config.ts', '--mode', mode]);
    declarations();
    fonts();
    notices();
    rmSync(join(pkgDir, 'schema'), { recursive: true, force: true });
    mkdirSync(join(pkgDir, 'schema'));
    for (const f of readdirSync(join(root, 'specs', 'schema')).filter((x) => x.endsWith('.json'))) copyFileSync(join(root, 'specs', 'schema', f), join(pkgDir, 'schema', f));
    copyFileSync(join(root, 'LICENSE'), join(pkgDir, 'LICENSE'));
    checkImports();
    for (const f of ['index.js', 'index.d.ts', 'element.js', 'element.d.ts', 'react.js', 'react.d.ts', 'arch-map.iife.js', 'fonts.css']) {
        if (!existsSync(join(dist, f))) throw new Error(`build-lib: dist/${f} is missing`);
    }
    const kb = (bytes: number) => `${Math.round(bytes / 1024)} kB`;
    const esm = readdirSync(dist).filter((x) => x.endsWith('.js') && !x.includes('iife')).reduce((n, f) => n + statSync(join(dist, f)).size, 0);
    console.error(`build-lib: @arch-map/viewer ${version} → ${relative(root, dist)} (ES modules ${kb(esm)}, arch-map.iife.js ${kb(statSync(join(dist, 'arch-map.iife.js')).size)}, fonts.css + ${readdirSync(join(dist, 'fonts')).length} font files, ${walk(join(dist, 'types')).length} declaration files, ${readdirSync(join(pkgDir, 'schema')).length} schemas)`);
}

/** `npm pack --dry-run`: the tarball holds only dist/, schema/, README.md, LICENSE and package.json. */
function pack(): void {
    const out = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], pkgDir);
    const [{ files, size, filename }] = JSON.parse(out) as { files: { path: string }[]; size: number; filename: string }[];
    const allowed = (p: string) => /^(dist|schema)\//.test(p) || ['README.md', 'LICENSE', 'package.json'].includes(p);
    const bad = files.map((f) => f.path).filter((p) => !allowed(p));
    if (bad.length) throw new Error(`build-lib: the package would hold ${bad.join(', ')}`);
    for (const need of ['README.md', 'LICENSE', 'package.json', 'dist/index.js', 'dist/arch-map.iife.js', 'schema/', ...noticePackages().map(noticePath)]) {
        if (!files.some((f) => f.path === need || (need.endsWith('/') && f.path.startsWith(need)))) throw new Error(`build-lib: the package lacks ${need}`);
    }
    const unwanted = files.map((f) => f.path).filter((p) => p.endsWith('.woff') || p === 'dist/arch-map.iife.js.map');
    if (unwanted.length) throw new Error(`build-lib: the package would hold ${unwanted.join(', ')}`);
    checkNotices();
    const tops = [...new Set(files.map((f) => f.path.split('/')[0]))].sort();
    console.error(`lib:pack: ${filename} — ${files.length} files (${tops.join(', ')}), ${Math.round(size / 1024)} kB packed; nothing else`);
}

try {
    build();
    if (process.argv.includes('--pack')) pack();
} catch (err) {
    console.error((err as Error).message);
    process.exit(1);
}
