import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkSpecSet } from 'arch-map/testing';
import { tally } from '../helpers.ts';
import type { ProjectManifest } from 'arch-map/types/project';

test('library: modules, model access, events, contracts and frontend calls are reproducible', () => {
    const home = fileURLToPath(new URL('../', import.meta.url));
    const manifest: ProjectManifest = JSON.parse(readFileSync(join(home, 'project.json'), 'utf8'));
    const result = checkSpecSet(manifest.documents.map((file) => join(home, 'specs', file)));
    assert.deepEqual(result.errors, []);
    const merged = result.merged!;
    const oracle = {
        elements: { app: 2, bus: 1, component: 16, datastore: 1, endpoint: 12, 'external-system': 2, module: 16, table: 6 },
        edges: { call: 12, event: 3, https: 1, import: 1, read: 6, references: 3, rest: 3, smtp: 1, webhook: 1, write: 7 },
        ids: ['library.api.loans.loan_module.loan_service', 'library.db.books', 'library.api.bus.library_bus', 'library.web.catalog.api'],
    };
    assert.deepEqual(tally(merged.elements.map((el) => el.type)), oracle.elements);
    assert.deepEqual(tally(merged.edges.map((edge) => edge.channel)), oracle.edges);
    for (const id of oracle.ids) assert.ok(merged.elements.some((el) => el.id === id), id);
    assert.ok(merged.elements.some((el) => el.contract));
    for (const file of manifest.determinism.outputs.filter((name) => name.endsWith('.unresolved.json'))) {
        assert.deepEqual(JSON.parse(readFileSync(join(home, 'specs', file), 'utf8')).entries, [], file);
    }
});
