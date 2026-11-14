import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('determinism guards nested input trees and detects a changed child', () => {
    const home = mkdtempSync(join(tmpdir(), 'map-guard-'));
    const project = join(home, 'sample');
    try {
        mkdirSync(join(project, 'target', 'nested'), { recursive: true });
        mkdirSync(join(project, 'specs'));
        writeFileSync(join(home, 'index.json'), JSON.stringify({ default: 'sample', order: ['sample'] }));
        writeFileSync(join(project, 'project.json'), JSON.stringify({ name: 'sample', title: 'Sample', documents: ['sample.json'], open: ['sample.json'], idPrefixes: ['sample'], env: {}, generate: { script: 'generate.mjs' }, determinism: { roots: [], outputs: ['sample.json'], guard: ['target'] } }));
        writeFileSync(join(project, 'target', 'nested', 'input.txt'), 'unchanged');
        const generator = join(project, 'generate.mjs');
        const stable = "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./specs/sample.json', import.meta.url), '{}');";
        writeFileSync(generator, stable);
        const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-determinism.ts', import.meta.url))], { encoding: 'utf8', env: { ...process.env, ARCH_MAP_PROJECTS: home } });
        const first = run();
        assert.equal(first.status, 0, first.stdout + first.stderr);
        assert.match(first.stdout, /unchanged/);
        writeFileSync(generator, stable + " writeFileSync(new URL('./target/nested/input.txt', import.meta.url), 'modified');");
        const second = run();
        assert.equal(second.status, 1, second.stdout + second.stderr);
        assert.match(second.stdout, /CHANGED/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
