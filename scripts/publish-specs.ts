// Copies the spec documents the viewer loads into viewer/public/specs/ (gitignored; docs/architecture.md AD-14): for every project of
// the projects directory (env ARCH_MAP_PROJECTS, scripts/lib/projects.ts) its documents and contracts/ (from
// <projects dir>/<name>/specs/) into <name>/, the shared schema/, and projects.json — { default, projects: [{ name,
// title, documents, open }] } in the switcher order, the only file the viewer reads about projects
// (viewer/src/projects.ts). Agents read the projects' specs/, never this copy. Needs no target checkout: specs are
// committed. With no project it publishes an empty list (the viewer then says "No projects"). It also writes the original
// license texts of what the site bundles (three.js, the fonts) and arch-map's own into viewer/public/licenses/ (gitignored),
// so `viewer:build` carries them in viewer/dist/licenses/ (scripts/lib/notices.ts).
import { rmSync, mkdirSync, cpSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECS_DIR } from './lib/spec-io.ts';
import { loadProjects, noProjects } from './lib/projects.ts';
import { copyNotices } from './lib/notices.ts';
import type { ViewerManifest } from '../types/project.ts';

const archDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(archDir, 'viewer', 'public', 'specs');

const { index, projects } = loadProjects();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const p of projects) {
    const dir = join(out, p.name);
    mkdirSync(dir, { recursive: true });
    for (const name of p.documents) copyFileSync(join(p.specsDir, name), join(dir, name));
    if (existsSync(join(p.specsDir, 'contracts'))) cpSync(join(p.specsDir, 'contracts'), join(dir, 'contracts'), { recursive: true });
}
cpSync(join(SPECS_DIR, 'schema'), join(out, 'schema'), { recursive: true });
const manifest: ViewerManifest = { default: index.default ?? null, projects: projects.map(({ name, title, documents, open, theme }) => ({ name, title, documents, open, ...(theme ? { theme } : {}) })) };
writeFileSync(join(out, 'projects.json'), `${JSON.stringify(manifest, null, 2)}\n`);
copyNotices(join(archDir, 'viewer', 'public', 'licenses'), { own: true });

if (!projects.length) console.log(`publish-specs: ${noProjects()} — published an empty project list → ${relative(process.cwd(), out) || out}`);
else console.log(
    `publish-specs: ${projects.map((p) => `${p.name} ${p.documents.length}`).join(', ')} document(s) → ${relative(process.cwd(), out) || out}; ` +
        `the map opens with ${index.default} (${projects.find((p) => p.name === index.default)!.open.join(', ')})`,
);
