// The hover card and the panel show a block's relations in the same figures and words (viewer/src/figures.ts): who
// uses it ("5 callers · 11 calls"), the tables, what it talks to; for a rail "publishers · published" and
// "subscribers · delivered". The card once summed calls under "incoming" while the panel counted callers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSpecs } from '../viewer/src/core/merge.ts';
import { adaptSpecs } from '../viewer/src/spec-adapter.ts';
import { buildModel, setDepths, summary } from '../viewer/src/model.ts';
import { blockFigures, relationFigures, figuresText, summaryHeads, cardFigures, hiddenRelations, unresolvedCalls, statusFigures } from '../viewer/src/figures.ts';
import type { ArchMapSpecDocument } from '../types/spec.d.ts';
import type { SpecEntry } from '../types/core.ts';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string): ArchMapSpecDocument => JSON.parse(readFileSync(join(here, 'fixtures', 'specs', f), 'utf8'));
const docs = ['sample-core.json', 'sample-client.json', 'five-tiers.json'];

/**
 * five-tiers with the cart calling orders twice more (cancel, over REST and over an event): one caller, three calls,
 * two channels — the case the card ("incoming", calls) and the panel ("Used by", entries) disagreed on.
 */
function busier(doc: ArchMapSpecDocument): ArchMapSpecDocument {
    const e = (toMethod: string, channel: 'rest' | 'event') => ({ id: `f.web.cart>f.api.orders#${toMethod}:${channel}`, from: 'f.web.cart', to: 'f.api.orders', toMethod, channel, provenance: 'authored' as const });
    doc.edges.push(e('cancel', 'rest'), e('cancelled', 'event'));
    return doc;
}

/** A model of each fixture document alone (they need not merge with each other). */
const models = docs.map((name) => {
    const merged = mergeSpecs([{ name, doc: name === 'five-tiers.json' ? busier(load(name)) : load(name) }], { strict: false });
    const model = buildModel(adaptSpecs(merged, [{ name, doc: { title: name } }] as unknown as SpecEntry[]));
    setDepths(model);
    return { name, model };
});

test('card and panel: the same figures, in the same words, for every block of the fixtures', () => {
    let blocks = 0, withCallers = 0, moreCalls = 0;
    for (const { name, model } of models)
        for (const n of model.nodes.values()) {
            const s = summary(model, n.id);
            // the card (cardStatsHtml in panel.ts renders these) and the panel's headings (summaryHtml renders these)
            const card = cardFigures(n, s, 3).map(figuresText).filter((f) => !/endpoint/.test(f));
            const panel = summaryHeads(n, s).map((h) => figuresText(h.figures));
            assert.deepEqual(card, panel, `${name} ${n.id}`);
            blocks++;
            if (s.in.length) withCallers++;
            const f = relationFigures(s, false);
            if (f.in[1].n > f.in[0].n) moreCalls++; // the case the card and the panel used to disagree on
        }
    assert.ok(blocks >= 19 && withCallers >= 15 && moreCalls >= 1, `${blocks} blocks, ${withCallers} with callers, ${moreCalls} with more calls than callers`);
});

test('the panel and the card render those figures and no others (source)', () => {
    const src = (f: string) => readFileSync(join(here, '..', 'viewer', 'src', f), 'utf8');
    assert.match(src('panel.ts'), /summaryHeads\(n, s\)/);
    assert.match(src('panel.ts'), /cardFigures\(n, s, countEndpoints\(n\)\)/);
    assert.match(src('card.ts'), /\$\{cardStatsHtml\(n, s\)\}/);
    assert.doesNotMatch(src('card.ts'), /reduce\(\(a, g\) => a \+ g\.n/, 'the card sums calls on its own again');
});

test('relationFigures: callers are distinct owners, calls the sum; one caller over two channels is one caller', () => {
    const e = (id: string, n: number) => ({ owner: { id }, n });
    const f = relationFigures({ in: [e('a', 6), e('b', 3), e('a', 2)], tables: [e('t', 1)], out: [e('x', 1)] }, false);
    assert.equal(figuresText(f.in), '2 callers · 11 calls');
    assert.equal(figuresText([f.tables]), '1 table');
    assert.equal(figuresText(f.out), '1 target · 1 call');
    const r = relationFigures({ in: [e('a', 4)], tables: [], out: [e('x', 2), e('y', 5)] }, true);
    assert.equal(figuresText(r.in), '1 publisher · 4 published');
    assert.equal(figuresText(r.out), '2 subscribers · 7 delivered');
});

test('the status line: relations a filter hides between placed blocks, unresolved calls; nothing that is 0', () => {
    const e = (id: string, from: string, to: string, raw: number) => ({ id, from, to, raw: Array.from({ length: raw }) });
    const inScope = [e('a|b|rest', 'a', 'b', 2), e('a|c|call', 'a', 'c', 3), e('a|x|call', 'a', 'x', 4), e('b|c|data', 'b', 'c', 1)];
    // drawn: a→b and b→c; a→c is hidden by a filter (3 raw relations); a→x ends on a block that is not placed
    assert.equal(hiddenRelations(inScope, new Set(['a|b|rest', 'b|c|data']), new Set(['a', 'b', 'c'])), 3);
    assert.equal(unresolvedCalls([{ methods: [{ unresolved: [{}, {}] }, {}] }, {}, { methods: [{ unresolved: [{}] }] }]), 3);
    assert.deepEqual(statusFigures(0, 0), []);
    assert.deepEqual(statusFigures(3, 1).map((s) => figuresText([s.figure])), ['3 relations hidden by filters', '1 unresolved call in the specs']);
    assert.deepEqual(statusFigures(0, 7).map((s) => figuresText([s.figure])), ['7 unresolved calls in the specs']);
});

test('a block\'s own figures: parts when it has any, endpoints when it has some — the panel\'s role line and the screen reader say these', () => {
    assert.deepEqual(blockFigures({ children: [1, 2], leafCount: 12 }, 83), [{ n: 12, unit: 'parts' }, { n: 83, unit: 'endpoints' }]);
    assert.deepEqual(blockFigures({ children: [1], leafCount: 1 }, 1), [{ n: 1, unit: 'part' }, { n: 1, unit: 'endpoint' }]);
    assert.deepEqual(blockFigures({ children: [], leafCount: 0 }, 0), []);
});
