// A parent cycle is an error of the set, in strict and in permissive merge, and it is cut so the model still builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSpecs } from '../viewer/src/core/merge.ts';
import { adaptSpecs } from '../viewer/src/spec-adapter.ts';
import { buildModel } from '../viewer/src/model.ts';
import type { SpecEntry } from '../types/core.ts';

const component = (id: string, parent: string | null) => ({ id, type: 'component', name: id, parent, provenance: 'authored' });
const entries = (els: object[]): SpecEntry[] =>
    [{ name: 'cycle.json', doc: { schemaVersion: '1.3.0', id: 'cycle', title: 'Cycle', elements: els, edges: [] } }] as unknown as SpecEntry[];

for (const strict of [true, false]) {
    test(`parent cycle: an error naming the cycle, and the model builds (strict: ${strict})`, () => {
        const docs = entries([component('c.a', 'c.b'), component('c.b', 'c.a'), component('c.leaf', 'c.a')]);
        const merged = mergeSpecs(docs, { strict });
        const cycles = merged.errors.filter((p) => p.message.startsWith('parent cycle'));
        assert.equal(cycles.length, 1);
        assert.match(cycles[0].message, /c\.a → c\.b → c\.a|c\.b → c\.a → c\.b/);
        assert.doesNotThrow(() => buildModel(adaptSpecs(merged, docs)));
    });
}

test('parent cycle: an element that is its own parent', () => {
    const merged = mergeSpecs(entries([component('c.self', 'c.self')]));
    assert.deepEqual(merged.errors.map((p) => p.message), ['parent cycle: c.self → c.self']);
});

test('a chain without a cycle is not reported', () => {
    const merged = mergeSpecs(entries([component('c.root', null), component('c.mid', 'c.root'), component('c.leaf', 'c.mid')]));
    assert.deepEqual(merged.errors, []);
});
