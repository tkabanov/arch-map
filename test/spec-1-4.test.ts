// Spec 1.4: what a document can say about how the map draws it — a glyph's `tone`, an element's `order` and `row` on
// its parent's board, and `edgeStyles` (a relation's dash, a legend filter, planned relations). Facet keys are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../scripts/lib/spec-io.ts';
import { mergeSpecs } from '../viewer/src/core/merge.ts';
import { adaptSpecs, styleOf } from '../viewer/src/spec-adapter.ts';
import { buildModel, foldEdges, KINDS, lineStyle } from '../viewer/src/model.ts';
import { layout } from '../viewer/src/layout.ts';
import type { ArchMapSpecDocument, EdgeStyle, Element } from '../types/spec.d.ts';
import type { SpecEntry } from '../types/core.ts';

const DASHED: EdgeStyle = { facet: 'acme.fetched', dash: 'dashed', role: 'Fetched on request' };
const NEXT: EdgeStyle = { facet: 'acme.next', dash: 'dotted', role: 'Next step', planned: true };
const el = (id: string, extra: Partial<Element> = {}): Element => ({ id, type: 'module', parent: 'app', name: id, provenance: 'authored', ...extra });
const doc = (over: Partial<ArchMapSpecDocument> = {}): ArchMapSpecDocument => ({
    schemaVersion: '1.4.0',
    id: 'd',
    title: 'd',
    glyphs: [{ facet: 'acme.broken', shape: 'grid', role: 'broken tool', tone: 'bad' }],
    edgeStyles: [DASHED, NEXT],
    elements: [
        { id: 'app', type: 'app', parent: null, name: 'App', tier: 'service', provenance: 'authored' },
        el('zeta', { order: 1, row: 0 }),
        el('alpha', { order: 2, row: 0 }),
        el('mid', { order: 3, row: 1, facets: { 'acme.broken': {} } }),
        el('beta'), // no order: after the ordered ones, by name
        { id: 'x', type: 'app', parent: null, name: 'X', tier: 'service', provenance: 'authored' },
    ],
    edges: [
        { id: 'app>x:call', from: 'app', to: 'x', channel: 'call', provenance: 'authored', facets: { 'acme.fetched': {} } },
        { id: 'x>app:call', from: 'x', to: 'app', channel: 'call', provenance: 'authored', facets: { 'acme.next': {} } },
        { id: 'x#run>app:call', from: 'x', to: 'app', channel: 'call', fromMethod: 'run', provenance: 'authored' },
    ],
    ...over,
});
const build = (d: ArchMapSpecDocument) => {
    const entries: SpecEntry[] = [{ name: 'd.json', doc: d }];
    const merged = mergeSpecs(entries, { strict: true });
    return { merged, raw: adaptSpecs(merged, entries) };
};

test('the schema takes tone, order, row and edgeStyles, and rejects unknown values', () => {
    assert.deepEqual(validate(doc()), []);
    assert.ok(validate(doc({ glyphs: [{ facet: 'acme.broken', shape: 'grid', role: 'x', tone: 'pink' as 'ok' }] })).length > 0);
    assert.ok(validate(doc({ edgeStyles: [{ ...DASHED, dash: 'wavy' as 'dashed' }] })).length > 0);
    assert.ok(validate(doc({ elements: [el('a', { row: -1 })] })).length > 0);
});

test('merge keeps the tone and one edge style list; a facet styled two ways is an error', () => {
    const { merged } = build(doc());
    assert.deepEqual(merged.errors, []);
    assert.equal(merged.glyphs[0].tone, 'bad');
    assert.deepEqual(merged.edgeStyles, [DASHED, NEXT]);
    const entries: SpecEntry[] = [{ name: 'd.json', doc: doc() }, { name: 'e.json', doc: { ...doc({ id: 'e', elements: [], edges: [] }), edgeStyles: [{ ...DASHED, dash: 'dotted' }] } }];
    assert.ok(mergeSpecs(entries, { strict: true }).errors.some((e) => /edge style of facet "acme.fetched" differs/.test(e.message)));
});

test('the adapter carries tone, order, row to nodes and the style to relations', () => {
    const { raw } = build(doc());
    const mid = raw.nodes.find((n) => n.id === 'mid')!;
    assert.deepEqual([mid.tone, mid.order, mid.row], ['bad', 3, 1]);
    const e = (id: string) => raw.edges.find((x) => x.id === id)!;
    assert.deepEqual([e('app>x:call').style, e('app>x:call').dash, e('app>x:call').planned], ['acme.fetched', 'dashed', undefined]);
    assert.deepEqual([e('x>app:call').dash, e('x>app:call').planned], ['dotted', true]);
    assert.equal(e('x#run>app:call').style, undefined);
    assert.deepEqual(styleOf(undefined, [DASHED]), {});
});

test('siblings stand by order, then by name; a new row value starts a new shelf', () => {
    const model = buildModel(build(doc()).raw);
    assert.deepEqual(model.nodes.get('app')!.children.map((c) => c.id), ['zeta', 'alpha', 'mid', 'beta']);
    const { placed } = layout(model, new Set(['app']), 60);
    const z = (id: string) => placed.find((n) => n.id === id)!._pos.z;
    const x = (id: string) => placed.find((n) => n.id === id)!._pos.x;
    assert.equal(z('zeta'), z('alpha'));
    assert.ok(x('zeta') < x('alpha'));
    assert.ok(z('mid') > z('alpha')); // row 1
    assert.ok(z('beta') > z('mid')); // no row: not row 1, so a shelf of its own
});

test('an edge style filter hides its relations; a line is dashed or planned only if all it folds are', () => {
    const model = buildModel(build(doc()).raw);
    const on = Object.fromEntries(Object.keys(KINDS).map((k) => [k, true]));
    const all = foldEdges(model, new Set(), on);
    assert.equal(all.reduce((a, f) => a + f.raw.length, 0), 3);
    const hidden = foldEdges(model, new Set(), { ...on, 'style:acme.next': false });
    assert.ok(!hidden.some((f) => f.raw.some((r) => r.id === 'x>app:call')));
    const back = all.find((f) => f.from === 'x')!; // e2 (planned, dotted) and e3 (plain) fold into one line
    assert.deepEqual(lineStyle(back), { dash: 'solid', planned: false });
    assert.deepEqual(lineStyle(hidden.find((f) => f.from === 'x')!), { dash: 'solid', planned: false });
    assert.deepEqual(lineStyle(all.find((f) => f.from === 'app')!), { dash: 'dashed', planned: false });
    assert.deepEqual(lineStyle({ raw: [model.edges.find((e) => e.id === 'x>app:call')!] }), { dash: 'dotted', planned: true });
});
