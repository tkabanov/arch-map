import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACET_READERS, facetReadLines } from '../scripts/lib/facet-guard.ts';

const violations = [
    'el.facets;',
    'el?.facets;',
    "el['facets'];",
    'el?.["facets"];',
    'el[`facets`];',
    "el[('facets' as const)];",
    'el[<const>"facets"];',
    'const { [<const>"facets"]: f } = el;',
    'const copy = { ...el, [<const>"facets"]: detail };',
    'const { facets } = el;',
    'const { facets: f = {} } = el;',
    "const { ['facets']: f } = el;",
    'const { nested: { facets: f } } = el;',
    '({ facets: f }) => f;',
    'function read({ facets }) {}',
    '({ facets } = el);',
    '({ facets: f } = el);',
    '({ nested: { facets: f } } = el);',
    'const { facets: _f, ...rest } = el;',
    '({ facets: f, ...rest } = el);',
    'const copy = { ...el.facets };',
    "const copy = { ...el['facets'] };",
    'const copy = { ...el, facets };',
    'const copy = { ...el, facets: detail };',
    "const copy = { ...el, ['facets']: detail };",
    '/* facets */ el.facets;',
    'el.facets = detail;',
];

for (const source of violations) {
    test(`facet guard rejects ${source}`, () => {
        assert.deepEqual(facetReadLines('core/example.ts', `// fixture\n${source}`), [2]);
    });
}

test('facet guard allows exactly the two readers, including all guarded syntax', () => {
    const source = violations.join('\n');
    for (const file of FACET_READERS) assert.deepEqual(facetReadLines(file, source), []);
    for (const file of ['core/panel.ts', 'nested/spec-adapter.ts', 'panel.js', 'spec-adapter.ts.bak']) {
        assert.equal(facetReadLines(file, source).length, violations.length);
    }
});

test('facet guard ignores comments, strings, type declarations and opaque spread/rest', () => {
    const source = `
        // el.facets
        /* el['facets'] */
        const text = "el.facets";
        const facets = 'local variable';
        interface Item { facets?: unknown }
        type Detail = Item['facets'];
        const { id: facets } = el;
        const [facets] = items;
        const copy = { ...el };
        const { id, ...rest } = el;
        ({ id, ...rest } = el);
        const { ...facets } = el;
        el[dynamicKey];
        el[facets];
        const { [facets]: f } = el;
        const value = { [facets]: f };
    `;
    assert.deepEqual(facetReadLines('core/merge.ts', source), []);
});

test('facet guard reports every occurrence at its source line', () => {
    assert.deepEqual(facetReadLines('scene.ts', '\nel\n .facets;\nel.facets; el["facets"];\n'), [2, 4, 4]);
});
