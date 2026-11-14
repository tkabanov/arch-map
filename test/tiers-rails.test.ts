// Tiers declared by the specs; buses, queues and jobs as cross-cutting rails. Pure modules only (merge, tier,
// resolve, path, adapter, model, layout); the browser checks (real wheel, hover, clicks) are described in docs/browser-checks.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../scripts/lib/spec-io.ts';
import { mergeSpecs } from '../viewer/src/core/merge.ts';
import { DEFAULT_TIERS, tierOf, isRail } from '../viewer/src/core/tier.ts';
import { resolveScenarios } from '../viewer/src/core/resolve.ts';
import { trace } from '../viewer/src/core/path.ts';
import { adaptSpecs } from '../viewer/src/spec-adapter.ts';
import { buildModel, foldEdges } from '../viewer/src/model.ts';
import { layout } from '../viewer/src/layout.ts';
import type { ArchMapSpecDocument } from '../types/spec.d.ts';
import type { MergedSet, SpecEntry } from '../types/core.ts';

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, 'fixtures', 'specs', 'five-tiers.json');
const text = readFileSync(path, 'utf8');
const five = (): ArchMapSpecDocument => JSON.parse(text);
const mergeOf = (...docs: ArchMapSpecDocument[]) => mergeSpecs(docs.map((doc, i) => ({ name: `d${i}.json`, doc })), { strict: true });
// (adaptSpecs reads only each document's title: stub entries)
const modelOf = (merged: MergedSet) => buildModel(adaptSpecs(merged, [{ name: 'f', doc: { title: 'f' } }] as unknown as SpecEntry[]));
const GAP = 34;
const all = (model: ReturnType<typeof modelOf>) => new Set([...model.nodes.values()].filter((n) => n.children.length).map((n) => n.id));

test('the schema takes `tiers`, any tier id on an element, and type `bus`', () => {
    assert.deepEqual(validate(five(), { file: path, text }), []);
    const bad = five();
    bad.tiers!.push({ id: 'Bad Tier', title: 'x' });
    assert.ok(validate(bad).some((e) => /pattern/.test(e.message)));
});

test('no tiers anywhere: the four default tiers, identical to before', () => {
    const doc = five();
    delete doc.tiers;
    doc.elements = doc.elements.filter((e) => e.id !== 'f.worker' && e.id !== 'f.worker.invoices');
    doc.edges = doc.edges.filter((e) => !e.to.startsWith('f.worker'));
    doc.scenarios = [];
    const m = mergeOf(doc);
    assert.deepEqual(m.errors, []);
    assert.deepEqual(m.tiers, DEFAULT_TIERS);
    assert.deepEqual(layout(modelOf(m), new Set(), GAP).plates.map((p) => p.layer.id), ['people', 'ui', 'service', 'data']);
});

test('one document declares five tiers: five plates in that order, `tier: async` lands on its own plate', () => {
    const m = mergeOf(five());
    assert.deepEqual(m.errors, []);
    assert.deepEqual(m.tiers.map((t) => t.id), ['people', 'ui', 'service', 'async', 'data']);
    assert.equal(tierOf(m, 'f.worker.invoices'), 'async');
    assert.equal(tierOf(m, 'f.db.orders'), 'data');
    const model = modelOf(m);
    const { plates, placed } = layout(model, new Set(), GAP);
    assert.deepEqual(plates.map((p) => p.layer.id), ['people', 'ui', 'service', 'async', 'data']);
    assert.deepEqual(plates.map((p) => p.layer.title), ['People', 'Interfaces', 'Services', 'Background work', 'Data']);
    const y = Object.fromEntries(plates.map((p) => [p.layer.id, p.y]));
    assert.ok(y.people > y.ui && y.ui > y.service && y.service > y.async && y.async > y.data);
    assert.equal(placed.find((n) => n.id === 'f.worker')!._pos.y, y.async);
});

test('unknown tier on an element, two different tier lists: merge errors naming doc and id (first wins when not strict)', () => {
    const doc = five();
    doc.elements.find((e) => e.id === 'f.worker')!.tier = 'queue';
    const m = mergeOf(doc);
    assert.ok(m.errors.some((e) => e.doc === 'd0.json' && e.id === 'f.worker' && /tier "queue" is not one of the tiers/.test(e.message)));

    // a minimal document for merge (no title): merge does not read one
    const other = { schemaVersion: '1.1.0', id: 'other', tiers: [{ id: 'ui', title: 'UI' }, { id: 'service', title: 'Services' }], elements: [], edges: [] } as unknown as ArchMapSpecDocument;
    const strict = mergeOf(five(), other);
    assert.ok(strict.errors.some((e) => e.doc === 'd1.json' && /declares tiers that differ from those of d0\.json/.test(e.message)));
    const loose = mergeSpecs([{ name: 'a.json', doc: five() }, { name: 'b.json', doc: other }], { strict: false });
    assert.deepEqual(loose.errors, []);
    assert.ok(loose.warnings.some((w) => w.doc === 'b.json' && /a\.json's are used/.test(w.message)));
    assert.equal(loose.tiers.length, 5);
    // the same list twice is fine
    assert.deepEqual(mergeOf(five(), { ...other, tiers: five().tiers }).errors, []);
});

test('a bus is a rail along its column\'s front just below its tier, never a column or a block on the board', () => {
    const m = mergeOf(five());
    const model = modelOf(m);
    assert.ok(isRail(model.nodes.get('f.api.events')));
    const open = layout(model, all(model), GAP);
    const rail = open.placed.find((n) => n.id === 'f.api.events')!;
    const api = open.placed.find((n) => n.id === 'f.api')!;
    const y = Object.fromEntries(open.plates.map((p) => [p.layer.id, p.y]));
    assert.ok(rail._rail && !rail._plate && !rail._column);
    assert.ok(rail._pos.y + rail._size.h < y.service && rail._pos.y > y.async, 'below the service plate, above the next one');
    const inApi = open.placed.filter((n) => n.id.startsWith('f.api.') && !n._rail);
    assert.ok(inApi.every((n) => rail._pos.z > n._pos.z + n._size.d), 'in front of the column, out of its footprint');
    assert.ok(rail._pos.x <= api._pos.x && rail._pos.x + rail._size.w >= api._pos.x + api._size.w, 'it spans the column');
    assert.ok(rail._size.w > rail._size.d * 5 && rail._size.h < 1, 'long and thin');
    // the board packs only the components: the rail took no cell on it
    for (const c of ['f.api.orders', 'f.api.mailer']) assert.ok(open.placed.find((n) => n.id === c)!._pos.y > y.service);
    assert.equal(model.roots.filter((r) => isRail(r)).length, 0);
});

test('collapsed app: the rail is not drawn and its events fold into the app’s relations', () => {
    const model = modelOf(mergeOf(five()));
    const { placed } = layout(model, new Set(), GAP);
    assert.ok(!placed.some((n) => n.id === 'f.api.events'));
    const filters = { rest: true, data: true, event: true, ext: true, interacts: true, call: true, import: true, references: true };
    const folded = foldEdges(model, new Set(), filters).map((e) => e.id);
    assert.ok(folded.includes('f.api|f.worker|event'), 'bus → worker folds to the app → worker');
    assert.ok(!folded.some((id) => id.includes('f.api.events')));
});

test('a scenario step over an event crosses the bus as one step: both edges, in order', () => {
    const m = mergeOf(five());
    const { scenarios, problems } = resolveScenarios(m);
    assert.deepEqual(problems, []);
    const step = scenarios[0].resolved[1];
    assert.deepEqual(step.edges.map((e) => e.id), ['f.api.orders#place>f.api.events#OrderPlaced:event', 'f.api.events#OrderPlaced>f.worker.invoices#onOrderPlaced:event']);
});

test('Path from a publisher: the subscribers reached through the bus are the next level', () => {
    const steps = trace(mergeOf(five()), 'f.api.orders', 'place');
    const bus = steps.find((s) => s.to === 'f.api.events');
    assert.equal(bus!.depth, 1);
    const subs = steps.filter((s) => s.from === 'f.api.events');
    assert.deepEqual(subs.map((s) => [s.to, s.depth]).sort(), [['f.api.mailer', 2], ['f.worker.invoices', 2]]);
});
