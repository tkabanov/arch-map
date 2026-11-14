// The browser checks (test/browser/*.test.ts): starts the viewer on a free port, runs the checks against it with real
// input in a real Chromium (playwright-core, pinned), stops the server. Not part of `npm test` / `check:all`: they
// need a GPU-backed browser and take a few minutes. docs/browser-checks.md.
// Usage: node scripts/test-browser.ts                 (dev server, every check)
//        node scripts/test-browser.ts --build         (viewer:build + vite preview: the offline demo build)
//        node scripts/test-browser.ts pinch wheel     (only test/browser/{pinch,wheel}.test.ts)
//        ARCH_MAP_URL=http://localhost:4848 node scripts/test-browser.ts   (against a server already running)
// Needs Chromium for playwright-core: `npx playwright-core install chromium` once (the checks say so if it is missing).
// The checks open the active projects (env ARCH_MAP_PROJECTS); with none they are skipped (exit 0) with a message.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects, noProjects } from './lib/projects.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const build = args.includes('--build');
const only = args.filter((a) => !a.startsWith('--'));
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

if (!process.env.ARCH_MAP_URL && !loadProjects().projects.length) {
    console.log(`test:browser: skipped — ${noProjects()}; the checks need a project to open`);
    process.exit(0);
}

const dir = join(root, 'test', 'browser');
const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort()
    .filter((f) => !only.length || only.includes(f.replace(/\.test\.ts$/, '')))
    .map((f) => join(dir, f));
if (!files.length) {
    console.error(`test:browser: no checks match ${only.join(', ')}`);
    process.exit(1);
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const a = s.address();
            s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
        });
    });
}

async function waitFor(url: string, ms = 30000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch {
            // not up yet
        }
        if (Date.now() - t0 > ms) throw new Error(`test:browser: ${url} did not answer in ${ms / 1000}s`);
        await new Promise((r) => setTimeout(r, 200));
    }
}

const run = (file: string, extra: string[]) => {
    const r = spawnSync(process.execPath, [join(root, file), ...extra], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
};

let server: ChildProcess | null = null;
let url = process.env.ARCH_MAP_URL;
if (!url) {
    run('scripts/publish-specs.ts', []);
    const port = await freePort();
    const viteArgs = build
        ? ['preview', 'viewer', '--outDir', 'dist', '--port', String(port), '--strictPort', '--host', '127.0.0.1']
        : ['viewer', '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
    if (build) {
        const b = spawnSync(process.execPath, [vite, 'build', 'viewer', '--outDir', 'dist', '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
        if (b.status !== 0) process.exit(b.status ?? 1);
    }
    server = spawn(process.execPath, [vite, ...viteArgs], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    url = `http://127.0.0.1:${port}`;
    await waitFor(url + '/');
    console.log(`test:browser: ${build ? 'preview build' : 'dev server'} at ${url}`);
}

const stop = () => { if (server && server.exitCode === null) server.kill(); };
process.on('SIGINT', () => { stop(); process.exit(130); });

// one file at a time: the checks measure timing (notches, fps), parallel browsers would skew them
const t = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ARCH_MAP_URL: url, ARCH_MAP_BUILD: build ? '1' : '' },
});
t.on('exit', (code) => {
    stop();
    process.exit(code ?? 1);
});
