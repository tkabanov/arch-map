// The neutrality guard (scripts/check-neutral.ts): what counts as naming a project, on synthetic projects; the extra
// terms of a projects directory; and that the real core, as checked in, names none of the fixture projects
// (test/fixtures/projects/) nor of the active ones (none when ARCH_MAP_PROJECTS is unset).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { termsOf, extraTermsOf, scanText, findHits, coreFiles, facetTermsOf, facetKeysOf } from '../scripts/check-neutral.ts';
import { allDocumentPaths, loadProjects, projectsDir } from '../scripts/lib/projects.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');
const fixtureDocs = loadProjects(FIXTURE).projects.flatMap((p) => p.documents.map((d) => join(p.specsDir, d)));

const terms = termsOf([
    { name: 'acme-shop', idPrefixes: ['shop', 'ext'], env: { ACME_ROOT: { about: 'x' } } },
]);
const hits = (line: string) => scanText('f.ts', line, terms).map((h) => h.term.from.split(': ')[1]);

test('a project name: whole word, any case; not inside a longer word or a dashed name', () => {
    assert.deepEqual(hits('// the acme-shop checkout'), ['name']);
    assert.deepEqual(hits('// Acme-Shop'), ['name']);
    assert.deepEqual(hits('// acme-shop-2 and my-acme-shop'), []);
    assert.deepEqual(hits('// acme shop'), []);
});

test('an env var name: exact, whole word', () => {
    assert.deepEqual(hits('process.env.ACME_ROOT'), ['env']);
    assert.deepEqual(hits('`${ACME_ROOT}/x`'), ['env']);
    assert.deepEqual(hits('MY_ACME_ROOT and ACME_ROOT_2 and acme_root'), []);
});

test('an id prefix: only as an id root, not as an ordinary word or a call', () => {
    assert.deepEqual(hits("id: 'shop.api.cart'"), ['idPrefixes']);
    assert.deepEqual(hits('`ext.web.<id>`'), ['idPrefixes']);
    assert.deepEqual(hits('shop.get(url)'), []); // a method call on a variable called like the prefix
    assert.deepEqual(hits('shop is a word; shopping.cart; myshop.api; the-shop.api'), []);
    assert.deepEqual(hits('the shop. Next sentence'), []);
});

test('reports file and line, comments included', () => {
    const r = scanText('a/b.ts', 'ok\n// x ACME_ROOT\nok', terms);
    assert.deepEqual(r.map((h) => [h.file, h.line]), [['a/b.ts', 2]]);
});

test('the scanned set: scripts, viewer/src, types, top-level tests and the root configs — not fixtures, browser tests or projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'neutral-'));
    try {
        const put = (rel: string, text = '// acme-shop\n') => {
            mkdirSync(dirname(join(root, rel)), { recursive: true });
            writeFileSync(join(root, rel), text);
        };
        const core = ['scripts/a.ts', 'scripts/stacks/s/b.ts', 'viewer/src/c.ts', 'types/d.ts', 'test/e.test.ts', 'specs/schema/s.json', 'package.json', 'tsconfig.json', '.dependency-cruiser.cjs', 'eslint.config.js', 'AGENTS.md', 'specs/README.md', '.env.example'];
        for (const rel of core) put(rel);
        for (const rel of ['projects/p/x.ts', 'projects/p/specs/x.json', 'examples/e/x.ts', 'test/browser/f.ts', 'test/fixtures/g.json', 'viewer/public/h.json', 'node_modules/i.ts', 'README.md', 'docs/x.md']) put(rel);
        const found = findHits(root, terms).map((h) => h.file).sort();
        assert.deepEqual(found, [...core].sort());
        assert.equal(coreFiles(root).length, found.length);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('extra terms: neutral-terms.json of a projects directory, whole word, any case; none without the file', () => {
    const extra = extraTermsOf(FIXTURE);
    assert.deepEqual(extra.map((t) => t.text), ['gamma-corp']);
    assert.equal(scanText('f.ts', '// for Gamma-Corp', extra).length, 1);
    assert.equal(scanText('f.ts', '// gamma-corporate', extra).length, 0);
    const dir = mkdtempSync(join(tmpdir(), 'neutral-terms-'));
    try {
        assert.deepEqual(extraTermsOf(dir), []);
        writeFileSync(join(dir, 'neutral-terms.json'), '{ "terms": [1] }');
        assert.throws(() => extraTermsOf(dir), /must be \{ "terms"/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the real core names no project: neither the fixture projects nor the active ones', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const fixture = [...termsOf(loadProjects(FIXTURE).projects), ...extraTermsOf(FIXTURE)];
    const active = [...termsOf(loadProjects().projects), ...extraTermsOf(projectsDir())];
    assert.ok(fixture.length > 0);
    // the core tests name their fixture projects; nothing else in the core does
    const found = [...findHits(root, fixture).filter((h) => !h.file.startsWith('test/')), ...findHits(root, active)];
    assert.deepEqual(found.map((h) => `${h.file}:${h.line} ${h.term.text}`), []);
});

test('a facet key: only in viewer/src, whole word, not a call', () => {
    const facets = facetTermsOf(['acme.widget', 'acme.widget']);
    assert.equal(facets.length, 1);
    const at = (file: string, line: string) => scanText(file, line, facets).length;
    assert.equal(at('viewer/src/x.ts', "['acme.widget', 'frame']"), 1);
    assert.equal(at('viewer/src/core/y.ts', '// the acme.widget facet'), 1);
    assert.equal(at('scripts/stacks/acme/z.ts', "facets: { 'acme.widget': {} }"), 0); // a stack emits its facets
    assert.equal(at('viewer/src/x.ts', 'acme.widgets; my-acme.widget; acme.widget(x)'), 0);
});

test('facet keys come from the documents: element and edge facets, glyphs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facets-'));
    try {
        const path = join(dir, 'd.json');
        writeFileSync(path, JSON.stringify({ elements: [{ facets: { 'a.one': {} } }], edges: [{ facets: { 'a.two': {} } }], glyphs: [{ facet: 'a.three' }] }));
        assert.deepEqual(facetKeysOf([path]), ['a.one', 'a.three', 'a.two']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the real viewer names no facet key of the specs', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const facets = facetTermsOf(facetKeysOf([...fixtureDocs, ...allDocumentPaths()]));
    assert.ok(facets.length > 0);
    assert.deepEqual(findHits(root, facets).map((h) => `${h.file}:${h.line} ${h.term.text}`), []);
});
