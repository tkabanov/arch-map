import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSpecs } from '../viewer/src/core/merge.ts';
import { adaptSpecs } from '../viewer/src/spec-adapter.ts';
import { buildModel } from '../viewer/src/model.ts';
import { layout } from '../viewer/src/layout.ts';
import { metricTints } from '../viewer/src/metrics.ts';
import type { ArchMapSpecDocument } from '../types/spec.d.ts';

test('metric coloring includes datastore logic and service blocks, but excludes plain tables and table groups', () => {
    const doc: ArchMapSpecDocument = {
        schemaVersion: '1.2.0', id: 'metrics', title: 'Metrics', elements: [
            { id: 'db', type: 'datastore', parent: null, name: 'Database', provenance: 'authored' },
            { id: 'db.logic', type: 'module', parent: 'db', name: 'Logic', provenance: 'authored' },
            { id: 'db.logic.fn', type: 'component', parent: 'db.logic', name: 'Function', provenance: 'authored', methods: [{ name: 'run' }] },
            { id: 'db.logic.fn.rpc', type: 'endpoint', parent: 'db.logic.fn', name: 'RPC', provenance: 'authored', handler: 'run', http: { method: 'POST', path: '/rpc/run' } },
            { id: 'db.tables', type: 'module', parent: 'db', name: 'Tables', provenance: 'authored' },
            { id: 'db.tables.items', type: 'table', parent: 'db.tables', name: 'Items', provenance: 'authored' },
            { id: 'api', type: 'app', parent: null, tier: 'service', name: 'API', provenance: 'authored' },
        ], edges: [
            { id: 'fn-write', from: 'db.logic.fn', fromMethod: 'run', to: 'db.tables.items', channel: 'write', provenance: 'authored' },
            { id: 'api-rpc', from: 'api', to: 'db.logic.fn.rpc', channel: 'rest', provenance: 'authored' },
        ],
    };
    const merged = mergeSpecs([{ name: 'metrics', doc }], { strict: true });
    assert.deepEqual(merged.errors, []);
    const model = buildModel(adaptSpecs(merged, []));
    for (const open of [false, true]) {
        const expanded = new Set(['db', ...(open ? ['db.logic', 'db.tables'] : [])]);
        const { placed } = layout(model, expanded, 34);
        for (const tint of ['api', 'db', 'coupling']) {
            const colors = metricTints(model, placed, tint)!;
            assert.ok(colors.get(open ? 'db.logic.fn' : 'db.logic')! > 0, `${tint}: logic has a metric`);
            assert.ok(colors.has('api'), 'service blocks retain metric coloring');
            for (const id of ['db', 'db.tables', 'db.tables.items']) assert.ok(!colors.has(id), id);
            if (open) assert.ok(!colors.has('db.logic'), 'expanded plates keep their ordinary colors');
        }
        assert.equal(metricTints(model, placed, 'kind'), null);
    }
});
