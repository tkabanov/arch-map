import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkSpecSet } from 'arch-map/testing';
import { tally } from '../helpers.ts';
import type { ProjectManifest } from 'arch-map/types/project';

test('tasks: database, platform, functions, client and journey form a deterministic set', () => {
    const home = fileURLToPath(new URL('../', import.meta.url));
    const manifest: ProjectManifest = JSON.parse(readFileSync(join(home, 'project.json'), 'utf8'));
    const result = checkSpecSet(manifest.documents.map((file) => join(home, 'specs', file)));
    assert.deepEqual(result.errors, []);
    const merged = result.merged!;
    const oracle = {
        elements: { app: 11, component: 8, datastore: 2, endpoint: 5, 'external-system': 1, job: 1, module: 9, system: 2, table: 11 },
        edges: { call: 3, https: 1, read: 19, references: 9, rest: 16, schedule: 1, trigger: 1, write: 20 },
        ids: ['tasks.db.task.tasks', 'tasks.files.attachments', 'tasks.cand.boards.board', 'tasks.edge.task.task_summary.index.post_task_summary', 'tasks.system.platform'],
    };
    assert.deepEqual(tally(merged.elements.map((el) => el.type)), oracle.elements);
    assert.deepEqual(tally(merged.edges.map((edge) => edge.channel)), oracle.edges);
    for (const id of oracle.ids) assert.ok(merged.elements.some((el) => el.id === id), id);
    assert.equal(result.scenarios![0].resolved.length, 5);
    assert.equal(Object.keys(merged.envelopes).length, 2);
    assert.ok(merged.elements.some((el) => el.contract));
    for (const file of manifest.determinism.outputs.filter((name) => name.endsWith('.unresolved.json'))) {
        assert.deepEqual(JSON.parse(readFileSync(join(home, 'specs', file), 'utf8')).entries, [], file);
    }
});
