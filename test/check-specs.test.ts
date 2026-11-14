// check-specs passes on the hand-made sample and fails with `file:line` on broken copies.
// Broken copies are made from the sample's text (one mutation each) in a temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSpec, serializeSpec, SCHEMA_REF, SpecInvalidError } from '../scripts/lib/spec-io.ts';
import { mergeSpecs } from '../viewer/src/core/merge.ts';

const archDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(archDir, 'test', 'fixtures', 'specs');
const coreText = readFileSync(join(fixtures, 'sample-core.json'), 'utf8');
const clientText = readFileSync(join(fixtures, 'sample-client.json'), 'utf8');

const check = (...args: string[]) => {
    const r = spawnSync(process.execPath, [join(archDir, 'scripts', 'check-specs.ts'), ...args], { cwd: archDir, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
};
const lineNo = (text: string, needle: string): number => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

test('sample passes', () => {
    const r = check(join(fixtures, 'index.json'));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /2 document\(s\), 9 elements, 3 edges, 1 scenarios/);
});

// Each case: a mutation of sample-core.json, the id expected in the message, the needle whose line is expected.
/** A broken copy: the mutation, the id in the message, and the line — of a needle, or the `nth` line with the id. */
interface Broken {
    mutate: (t: string) => string;
    id: string;
    line?: string;
    nth?: number;
    message: RegExp;
}
const broken: Record<string, Broken> = {
    'unknown-type': {
        mutate: (t) => t.replace('"type": "module"', '"type": "widget"'),
        id: 'app.api.payment.payment_module',
        line: '"id": "app.api.payment.payment_module"',
        message: /\/type: must be one of/,
    },
    'extra-field': {
        mutate: (t) => t.replace('"name": "MySQL",', '"name": "MySQL",\n      "owner": "dba",'),
        id: 'app.db',
        line: '"id": "app.db"',
        message: /unknown field "owner"/,
    },
    'bad-id': {
        mutate: (t) => t.replace('"id": "paygate"', '"id": "PayGate"'),
        id: 'PayGate',
        line: '"id": "PayGate"',
        message: /\/id: must match pattern/,
    },
    'app-with-parent': {
        mutate: (t) => t.replace('"parent": null,\n      "name": "shop-backend"', '"parent": "app.db",\n      "name": "shop-backend"'),
        id: 'app.api',
        line: '"id": "app.api"',
        message: /\/parent: must be null/,
    },
    'extracted-without-source': {
        mutate: (t) => t.replace('"source": { "repo": "backend", "file": "src/modules/payment/payment.module.ts", "line": 12 },\n', ''),
        id: 'app.api.payment.payment_module',
        line: '"id": "app.api.payment.payment_module"',
        message: /extracted element needs a code source/,
    },
    'duplicate-id': {
        mutate: (t) => {
            const start = t.indexOf('    {\n      "id": "paygate"');
            const end = t.indexOf('\n    }', start) + '\n    }'.length;
            return t.slice(0, end) + ',\n' + t.slice(start, end) + t.slice(end);
        },
        id: 'paygate',
        nth: 2,
        message: /duplicate element id/,
    },
};

for (const [name, c] of Object.entries(broken)) {
    test(`broken copy fails with file:line — ${name}`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'arch-map-specs-'));
        try {
            const text = c.mutate(coreText);
            assert.notEqual(text, coreText, 'mutation applied');
            const file = join(dir, `${name}.json`);
            writeFileSync(file, text);
            const r = check(file);
            assert.equal(r.code, 1, r.out);
            const want = c.nth
                ? text.split('\n').map((l, i): [string, number] => [l, i + 1]).filter(([l]) => l.includes(`"id": "${c.id}"`))[c.nth - 1][1]
                : lineNo(text, c.line!);
            const re = new RegExp(`${name}\\.json:${want}: .*\\(${c.id.replace(/\./g, '\\.')}\\)$`, 'm');
            assert.match(r.err, re);
            assert.match(r.err, c.message);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

test('second claim of an app fails', () => {
    const core = JSON.parse(coreText);
    const overlay = JSON.parse(clientText);
    overlay.elements.push({ id: 'ovl.sys.other', type: 'system', parent: null, name: 'Other', provenance: 'authored', contains: ['app.api'] });
    const m = mergeSpecs([{ name: 'sample-client.json', doc: overlay }, { name: 'sample-core.json', doc: core }]);
    assert.deepEqual(m.errors.map((e) => e.id), ['ovl.sys.other']);
    assert.match(m.errors[0].message, /already claimed by ovl\.sys\.backend/);
});

test('merge sets the parent of claimed apps; claims are off without systems', () => {
    const core = JSON.parse(coreText);
    const overlay = JSON.parse(clientText);
    const m = mergeSpecs([{ name: 'sample-client.json', doc: overlay }, { name: 'sample-core.json', doc: core }]);
    assert.deepEqual(m.errors, []);
    assert.equal(m.byId.get('app.api')!.parent, 'ovl.sys.backend');
    assert.equal(m.byId.get('paygate')!.name, 'PayGate (payments)');
    assert.equal(core.elements[0].parent, null, 'inputs are not mutated');
    assert.deepEqual(mergeSpecs([{ name: 'sample-core.json', doc: core }]).errors, []);
});

test('requires scoping: a reference outside requires fails; a subset drops it with a warning', () => {
    const core = JSON.parse(coreText);
    const overlay = JSON.parse(clientText);
    delete overlay.requires;
    const strict = mergeSpecs([{ name: 'sample-client.json', doc: overlay }, { name: 'sample-core.json', doc: core }]);
    assert.ok(strict.errors.some((e) => /not in "requires"/.test(e.message)));
    const subset = mergeSpecs([{ name: 'sample-client.json', doc: JSON.parse(clientText) }], { strict: false });
    assert.deepEqual(subset.errors, []);
    assert.ok(subset.warnings.length > 0);
});

test('writeSpec is deterministic and refuses invalid documents', () => {
    const doc = JSON.parse(coreText);
    const shuffled = { ...doc, elements: [...doc.elements].reverse(), edges: [...doc.edges].reverse() };
    assert.equal(serializeSpec(doc), serializeSpec(shuffled));
    assert.ok(serializeSpec(doc).endsWith('}\n'));
    const dir = mkdtempSync(join(tmpdir(), 'arch-map-specs-'));
    try {
        const bad = { ...doc, elements: [...doc.elements, { id: 'x', type: 'widget', parent: null, name: 'x', provenance: 'extracted' }] };
        assert.throws(() => writeSpec(join(dir, 'bad.json'), bad), SpecInvalidError);
        assert.throws(() => readFileSync(join(dir, 'bad.json')), /ENOENT/);
        writeSpec(join(dir, 'ok.json'), doc);
        // `$schema` is the published tree's (`<project>/<doc>` next to `schema/`), wherever the file is written
        const written = readFileSync(join(dir, 'ok.json'), 'utf8');
        assert.equal(written, serializeSpec({ ...doc, $schema: SCHEMA_REF }));
        assert.equal(JSON.parse(written).$schema, '../schema/spec.schema.json');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
