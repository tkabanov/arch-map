// Glyphs are data (AD-13): the stack that emits a facet declares its glyph and role in the document's `glyphs`;
// merge keeps one ordered list for the set and the adapter reads it. The viewer names no facet key, so the keys
// here are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../scripts/lib/spec-io.ts';
import { mergeSpecs } from '../viewer/src/core/merge.ts';
import { adaptSpecs, shapeOf } from '../viewer/src/spec-adapter.ts';
import type { ArchMapSpecDocument, Glyph } from '../types/spec.d.ts';
import type { SpecEntry } from '../types/core.ts';

const doc = (id: string, glyphs?: Glyph[]): ArchMapSpecDocument => ({
    schemaVersion: '1.3.0',
    id,
    title: id,
    ...(glyphs ? { glyphs } : {}),
    elements: [
        { id: `${id}.a`, type: 'component', parent: null, name: 'a', provenance: 'authored', facets: { 'acme.widget': {} } },
        { id: `${id}.b`, type: 'component', parent: null, name: 'b', provenance: 'authored', facets: { 'acme.widget': {}, 'acme.gadget': {} } },
        { id: `${id}.c`, type: 'table', parent: null, name: 'c', provenance: 'authored', facets: { 'acme.other': {} } },
    ],
    edges: [],
});
const WIDGET: Glyph = { facet: 'acme.widget', shape: 'frame', role: 'widget' };
const GADGET: Glyph = { facet: 'acme.gadget', shape: 'arrow', role: 'gadget' };

const adapt = (docs: ArchMapSpecDocument[], opts: { strict?: boolean; nofacets?: boolean } = {}) => {
    const entries: SpecEntry[] = docs.map((d) => ({ name: `${d.id}.json`, doc: d }));
    const merged = mergeSpecs(entries, { strict: opts.strict ?? true });
    const raw = adaptSpecs(merged, entries, { nofacets: opts.nofacets });
    return { merged, shape: (id: string) => { const n = raw.nodes.find((x) => x.id === id)!; return `${n.shape}/${n.role}`; } };
};

test('the schema takes `glyphs` and rejects an unknown glyph or a malformed facet key', () => {
    assert.deepEqual(validate(doc('d', [WIDGET, GADGET])), []);
    assert.ok(validate(doc('d', [{ ...WIDGET, shape: 'hexagon' as Glyph['shape'] }])).length > 0);
    assert.ok(validate(doc('d', [{ ...WIDGET, facet: 'widget' }])).length > 0);
    assert.ok(validate(doc('d', [{ facet: 'acme.widget', shape: 'frame' } as Glyph])).length > 0);
});

test('the adapter draws an element by the glyph its document declares for its facet', () => {
    const { merged, shape } = adapt([doc('d', [WIDGET, GADGET])]);
    assert.deepEqual(merged.errors, []);
    assert.deepEqual(merged.glyphs, [WIDGET, GADGET]);
    assert.equal(shape('d.a'), 'frame/widget');
    assert.equal(shape('d.c'), 'grid/table'); // no declaration for its facet: the core type
});

test('the declaration order decides between two facets of one element', () => {
    assert.equal(adapt([doc('d', [WIDGET, GADGET])]).shape('d.b'), 'frame/widget');
    assert.equal(adapt([doc('d', [GADGET, WIDGET])]).shape('d.b'), 'arrow/gadget');
});

test('no declaration, or facets stripped: the core type fallback', () => {
    const plain = adapt([doc('d')]);
    assert.equal(plain.shape('d.a'), 'core/component');
    assert.equal(adapt([doc('d', [WIDGET])], { nofacets: true }).shape('d.a'), 'core/component');
});

test('a declaration applies across documents: an overlay without glyphs gets the other document\'s', () => {
    const { merged, shape } = adapt([doc('o'), doc('d', [WIDGET])]);
    assert.deepEqual(merged.errors, []);
    assert.equal(shape('o.a'), 'frame/widget');
});

test('one facet, two declarations: same is fine, different is a merge error (first wins when not strict)', () => {
    assert.deepEqual(adapt([doc('d', [WIDGET]), doc('e', [WIDGET])]).merged.errors, []);
    const other = { ...WIDGET, shape: 'ring' as const };
    const strict = adapt([doc('d', [WIDGET]), doc('e', [other])]);
    assert.ok(strict.merged.errors.some((e) => e.doc === 'e.json' && /glyph of facet "acme.widget" differs from the one in d\.json/.test(e.message)));
    const loose = adapt([doc('d', [WIDGET]), doc('e', [other])], { strict: false });
    assert.deepEqual(loose.merged.errors, []);
    assert.equal(loose.merged.warnings.length, 1);
    assert.equal(loose.shape('e.a'), 'frame/widget');
    const twice = adapt([doc('d', [WIDGET, WIDGET])]);
    assert.ok(twice.merged.errors.some((e) => /facet "acme.widget" declared twice/.test(e.message)));
});

test('shapeOf without a glyph list is the core fallback', () => {
    assert.deepEqual(shapeOf({ type: 'job', facets: { 'acme.widget': {} } }), { shape: 'clock', role: 'job' });
    assert.deepEqual(shapeOf({ type: 'job', facets: { 'acme.widget': {} } }, [WIDGET]), { shape: 'frame', role: 'widget' });
});

test('a facet declared twice inside one document is an error, whatever an earlier document declared', () => {
    for (const strict of [true, false]) {
        for (const order of [['a', 'b'], ['b', 'a']]) {
            const docs = order.map((id) => doc(id, id === 'a' ? [WIDGET] : [WIDGET, WIDGET]));
            const { merged } = adapt(docs, { strict });
            const twice = merged.errors.filter((e) => /facet "acme.widget" declared twice/.test(e.message));
            assert.deepEqual(twice.map((e) => e.doc), ['b.json'], `strict ${strict}, order ${order.join(',')}`);
            assert.deepEqual(merged.glyphs, [WIDGET]);
        }
    }
});

test('every declarable glyph has a drawing: a case in shapes.ts, or `matrix` (the default branch); a rail is not declarable', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const schema = JSON.parse(readFileSync(join(root, 'specs/schema/spec.schema.json'), 'utf8'));
    const declarable: string[] = schema.$defs.glyph.properties.shape.enum;
    const src = readFileSync(join(root, 'viewer/src/shapes.ts'), 'utf8');
    const sw = src.slice(src.indexOf('switch (n.shape) {'));
    const block = sw.slice(0, sw.indexOf('\n    }\n')); // the switch closes at the function's indent
    const cases = new Set([...block.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));
    assert.ok(cases.size >= 8 && /\bdefault:/.test(block), 'the glyph switch was found');
    assert.deepEqual(declarable.filter((s) => s !== 'matrix' && !cases.has(s)), []);
    assert.ok(!declarable.includes('rail'));
});
