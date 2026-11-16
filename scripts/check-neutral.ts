// Neutrality guard: the generic core names no concrete project. Every project's facts (name, id prefixes, env var
// names) come from the active projects' manifests (<projects dir>/<p>/project.json, env ARCH_MAP_PROJECTS), plus the
// optional extra words of <projects dir>/neutral-terms.json (`{ "terms": [...] }`: names the manifests do not hold, such
// as a client's or a product's — a private projects directory keeps the public core clean with it); this check reads
// them and fails when scripts/ (stacks included), viewer/src/, types/, the top-level generic tests, specs/schema/, the
// root configs or the core docs (AGENTS.md, specs/README.md, .env.example) mention one — comments included. It is
// data-driven, so the guard itself names no project. With no projects there is nothing to forbid: it says so, exit 0.
// The viewer (viewer/src/) also names no facet key: a stack's facets are drawn by the glyphs its documents declare
// (AD-13), so a new stack never edits the viewer. The keys come from every project's spec documents (element and edge
// `facets`, `glyphs`); scripts/ may name them (the stacks emit them).
// Rules (precise, so that no allow-list is needed):
// - a project name, an extra term or an env var name: whole word, case-insensitive for the name, exact for env var names;
// - an id prefix: only as an id root, i.e. a whole word followed by `.` and a name, as in `<prefix>.<segment>`, and
//   not a call (`<prefix>.<name>(`): a prefix can also be an ordinary word (a variable called like it), and then it is
//   not the project that is named;
// - a name that is also an ordinary word the core needs would break the rule: rename the project, not the code;
// - a facet key (viewer/src/ only): whole word, exact, not a call — as an id prefix.
// Usage: node scripts/check-neutral.ts   (npm run check:neutral); exit 1 on any hit.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allDocumentPaths, loadProjects, projectsDir, noProjects } from './lib/projects.ts';
import type { Project } from '../types/project.ts';
import type { ArchMapSpecDocument } from '../types/spec.d.ts';

export interface Term {
    /** what is searched for, for the message */
    text: string;
    test: (line: string) => boolean;
    /** which project and which field it comes from */
    from: string;
    /** only files under this path (relative, `/`-separated) are searched; all core files when absent */
    within?: string;
}
export interface Hit {
    file: string;
    line: number;
    term: Term;
    text: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a word boundary that treats `-`, `_` and `.`-joined identifiers as part of the word where it matters:
// not preceded or followed by a letter, digit, `_` or `-`.
const BEFORE = '(?<![A-Za-z0-9_-])';
const AFTER = '(?![A-Za-z0-9_-])';

const wordTest = (re: RegExp) => (line: string) => re.test(line);
/** `<key>` as a whole word, not followed by `(` (a member call is code, not a facet key). */
function exactTest(key: string): (line: string) => boolean {
    const re = new RegExp(`${BEFORE}${escapeRe(key)}${AFTER}`, 'g');
    return (line) => [...line.matchAll(re)].some((m) => line[m.index + m[0].length] !== '(');
}

/** `<prefix>.<segment>[.<segment>…]` not followed by `(` (a member call is code, not an id). */
function idRootTest(prefix: string): (line: string) => boolean {
    const re = new RegExp(`${BEFORE}${escapeRe(prefix)}\\.[A-Za-z_][\\w]*(?:\\.[\\w<>]+)*`, 'g');
    return (line) => [...line.matchAll(re)].some((m) => line[m.index + m[0].length] !== '(');
}

/** The searched terms of the projects. */
export function termsOf(projects: Pick<Project, 'name' | 'idPrefixes' | 'env'>[]): Term[] {
    const terms: Term[] = [];
    for (const p of projects) {
        terms.push({ text: p.name, test: wordTest(new RegExp(`${BEFORE}${escapeRe(p.name)}${AFTER}`, 'i')), from: `${p.name}: name` });
        for (const prefix of p.idPrefixes) terms.push({ text: `${prefix}.`, test: idRootTest(prefix), from: `${p.name}: idPrefixes` });
        for (const env of Object.keys(p.env)) terms.push({ text: env, test: wordTest(new RegExp(`${BEFORE}${escapeRe(env)}${AFTER}`)), from: `${p.name}: env` });
    }
    return terms;
}

/** The extra words of a projects directory (`neutral-terms.json`: `{ "terms": string[] }`), as terms; none without the file. */
export function extraTermsOf(dir: string): Term[] {
    const file = join(dir, 'neutral-terms.json');
    if (!existsSync(file)) return [];
    const { terms } = JSON.parse(readFileSync(file, 'utf8')) as { terms?: unknown };
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string' && t.length > 0)) throw new Error(`${file}: must be { "terms": [non-empty strings] }`);
    return terms.map((t) => ({ text: t, test: wordTest(new RegExp(`${BEFORE}${escapeRe(t)}${AFTER}`, 'i')), from: 'neutral-terms.json' }));
}

/** Facet keys the viewer must not name: searched in viewer/src/ only. */
export function facetTermsOf(keys: Iterable<string>): Term[] {
    return [...new Set(keys)].sort().map((key) => ({ text: key, test: exactTest(key), from: 'specs: facet key', within: 'viewer/src/' }));
}

/** Every facet key the spec documents at `paths` use or declare (element and edge `facets`, `glyphs`). */
export function facetKeysOf(paths: string[]): string[] {
    const keys = new Set<string>();
    for (const path of paths) {
        const doc = JSON.parse(readFileSync(path, 'utf8')) as ArchMapSpecDocument;
        for (const x of [...(doc.elements ?? []), ...(doc.edges ?? [])]) for (const k of Object.keys(x.facets ?? {})) keys.add(k);
        for (const g of doc.glyphs ?? []) keys.add(g.facet);
        for (const st of doc.edgeStyles ?? []) keys.add(st.facet);
    }
    return [...keys].sort();
}

/** Every line of `text` that holds a term. */
export function scanText(file: string, text: string, terms: Term[]): Hit[] {
    const hits: Hit[] = [];
    const here = terms.filter((t) => !t.within || file.startsWith(t.within));
    text.split('\n').forEach((line, i) => {
        for (const term of here) if (term.test(line)) hits.push({ file, line: i + 1, term, text: line.trim() });
    });
    return hits;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', 'fixtures', '.git']);
const TEXT = /\.(ts|js|cjs|mjs|json|html|css)$/;

function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir).sort()) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (TEXT.test(name)) out.push(full);
    }
}

/** The core docs that are scanned too (they describe the core, so they name no project either). */
const CORE_DOCS = ['AGENTS.md', 'specs/README.md', '.env.example'];

/** The files the generic core consists of, under `root`. */
export function coreFiles(root: string): string[] {
    const out: string[] = [];
    for (const d of ['scripts', 'viewer/src', 'types', 'specs/schema']) if (existsSync(join(root, d))) walk(join(root, d), out);
    for (const name of readdirSync(join(root, 'test')).sort()) if (name.endsWith('.ts')) out.push(join(root, 'test', name)); // top level only
    for (const name of readdirSync(root).sort()) if (/^(package\.json|tsconfig.*\.json|eslint\.config\..*|\.dependency-cruiser\.cjs)$/.test(name)) out.push(join(root, name));
    for (const rel of CORE_DOCS) if (existsSync(join(root, rel))) out.push(join(root, rel));
    return out;
}

/** All hits of `terms` in the core under `root`. */
export function findHits(root: string, terms: Term[]): Hit[] {
    return coreFiles(root).flatMap((f) => scanText(relative(root, f).split(sep).join('/'), readFileSync(f, 'utf8'), terms));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = join(fileURLToPath(import.meta.url), '..', '..');
    const { projects } = loadProjects();
    const extra = extraTermsOf(projectsDir());
    if (!projects.length && !extra.length) {
        console.log(`check:neutral: ok — ${noProjects()}: nothing to forbid`);
        process.exit(0);
    }
    const terms = [...termsOf(projects), ...extra];
    const facets = facetTermsOf(facetKeysOf(allDocumentPaths()));
    const hits = findHits(root, [...terms, ...facets]);
    for (const h of hits) console.log(`${h.file}:${h.line}  "${h.term.text}" (${h.term.from})  ${h.text.slice(0, 110)}`);
    console.log(
        hits.length
            ? `check:neutral: ${hits.length} hit(s) — the generic core must not name a project, nor the viewer a facet key`
            : `check:neutral: ok — ${terms.length} terms from ${projects.length} project manifest(s)${extra.length ? ` and neutral-terms.json (${extra.length})` : ''}, none named in the generic core; ${facets.length} facet keys from the specs, none named in viewer/src`,
    );
    process.exit(hits.length ? 1 : 0);
}
