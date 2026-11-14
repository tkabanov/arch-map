// check:arch over a projects directory outside this checkout, reached through a symlink (scripts/check-arch.ts,
// .dependency-cruiser.cjs): the core is a package dependency there (node_modules/arch-map → this checkout), the
// projects dir is canonicalized the same way in the runner and the config, so a clean project has no violation and a
// relative import into the core is caught. On macOS the temp dir is itself a symlink (/var → /private/var).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const archDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('check:arch: an external projects dir behind a symlink — clean project passes, a relative import into the core fails', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'arch-map-ext-'));
    try {
        mkdirSync(join(tmp, 'node_modules'));
        symlinkSync(archDir, join(tmp, 'node_modules', 'arch-map'), 'dir');
        const dir = join(tmp, 'owner-projects');
        const demo = join(dir, 'demo');
        mkdirSync(join(demo, 'specs'), { recursive: true });
        writeFileSync(join(dir, 'index.json'), JSON.stringify({ default: 'demo', order: ['demo'] }));
        writeFileSync(join(demo, 'project.json'), JSON.stringify({
            name: 'demo', title: 'demo', documents: ['demo.json'], open: ['demo.json'], idPrefixes: ['demo'], env: {},
            generate: { script: 'generate.ts' }, determinism: { roots: [], outputs: ['demo.json'] },
        }));
        writeFileSync(join(demo, 'config.ts'), "export const HOME = 'projects/demo';\n");
        // an import inside the project: depcruise resolves it to its physical path, the entry is the path as given
        writeFileSync(join(demo, 'generate.ts'), "import { HOME } from './config.ts';\nimport { specsDirOf } from 'arch-map/generator';\nexport const home = HOME;\nimport type { ArchMapSpecDocument } from 'arch-map/types/spec';\nexport const out: string = specsDirOf('.');\nexport type Doc = ArchMapSpecDocument;\n");
        const link = join(tmp, 'link');
        symlinkSync(dir, link, 'dir');
        const run = () => spawnSync(process.execPath, [join(archDir, 'scripts', 'check-arch.ts')], { cwd: archDir, encoding: 'utf8', env: { ...process.env, ARCH_MAP_PROJECTS: link } });

        const ok = run();
        assert.equal(ok.status, 0, ok.stdout + ok.stderr);
        assert.match(ok.stdout, /no dependency violations/);

        const intoCore = relative(realpathSync(demo), join(realpathSync(archDir), 'scripts', 'lib', 'spec-io.ts')).split('\\').join('/');
        writeFileSync(join(demo, 'bad.ts'), `import { lineOf } from '${intoCore}';\nexport const n: number = lineOf('', '');\n`);
        const bad = run();
        assert.notEqual(bad.status, 0, bad.stdout);
        assert.match(bad.stdout, /project-core-via-package: .*demo\/bad\.ts → scripts\/lib\/spec-io\.ts/);
        assert.match(bad.stdout, /project-public-api-only: .*demo\/bad\.ts → scripts\/lib\/spec-io\.ts/);
        assert.doesNotMatch(bad.stdout, /generate\.ts/);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
