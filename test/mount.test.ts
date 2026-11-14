// The pure half of `mount` (viewer/src/options.ts): the options' defaults, the theme an option names, the documents as
// given (objects, `{ name, doc }`), and the check every set passes before a map is drawn — the errors `onError` gets and
// the contract documents that load on first use. The browser half: test/browser/embed.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveOptions, themeOf, specEntries, checkSpecs, nameOfUrl, folderOf, mapError } from '../viewer/src/options.ts';
import type { ArchMapSpecDocument } from '../types/spec.d.ts';

const doc = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/specs/${name}`, import.meta.url), 'utf8')) as ArchMapSpecDocument;
const core = doc('sample-core.json'), client = doc('sample-client.json');

test('options: an embed by default — no URL, the keys only while focused, preferences under archMap, no debug API', () => {
    assert.deepEqual(resolveOptions(), { urlState: false, storageKey: 'archMap', keyboard: 'focus', debug: false, nofacets: false });
    assert.deepEqual(resolveOptions({ urlState: true, keyboard: 'page', debug: true, storageKey: 'docsMap' }), { urlState: true, storageKey: 'docsMap', keyboard: 'page', debug: true, nofacets: false });
    assert.equal(resolveOptions({ storageKey: false }).storageKey, false);
    assert.equal(resolveOptions({ storageKey: '' }).storageKey, 'archMap', 'an empty prefix is the default');
    assert.equal(resolveOptions({ keyboard: 'everywhere' as 'page' }).keyboard, 'focus', 'an unknown value is the default');
});

test('theme option: a name, a project theme over its base, the dark look otherwise', () => {
    assert.equal(themeOf(undefined).mode, 'dark');
    assert.equal(themeOf('light').mode, 'light');
    const brand = themeOf({ base: 'light', colors: { accent: '#F4263D' }, fonts: { ui: 'Manrope' } });
    assert.equal(brand.mode, 'light');
    assert.equal(brand.colors.accent, '#f4263d');
    assert.equal(brand.fonts.ui, 'Manrope');
    assert.equal(themeOf('sepia' as 'dark').mode, 'dark');
});

test('documents as given: { name, doc } keeps the name others require it by; a bare document is named by its id', () => {
    const entries = specEntries([{ name: 'sample-core.json', doc: core }, client]);
    assert.deepEqual(entries.map((e) => e.name), ['sample-core.json', 'sample-client.json']);
    assert.equal(entries[1].doc, client);
    assert.equal(nameOfUrl('specs/tasks/a.json?v=2'), 'a.json');
    assert.equal(folderOf('specs/tasks/a.json'), 'specs/tasks/');
    assert.equal(folderOf('a.json'), '');
});

test('check: a good set merges and names its contract documents; warnings are passed on', () => {
    const r = checkSpecs(specEntries([core, client]));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.merged.elements.length > 0);
    assert.ok(r.contractNames instanceof Set);
    assert.ok(Array.isArray(r.warnings));
});

test('check: no documents, another schema major, a document that is not one, specs that do not agree — each an error with lines', () => {
    assert.deepEqual(checkSpecs([]), { ok: false, title: 'No spec documents', lines: ['give `specs` or `specsUrl`'] });
    const v2 = checkSpecs(specEntries([{ ...core, schemaVersion: '2.0.0' }]));
    assert.deepEqual(v2, { ok: false, title: 'Incompatible spec version: 2.0.0 (expected 1.x)', lines: ['sample-core.json'] });
    const junk = checkSpecs([{ name: 'x.json', doc: null as unknown as ArchMapSpecDocument }]);
    assert.deepEqual(junk, { ok: false, title: 'Not a spec document', lines: ['x.json'] });
    // the same document twice: its ids clash
    const twice = checkSpecs(specEntries([core, core]));
    assert.equal(twice.ok, false);
    if (twice.ok) return;
    assert.equal(twice.title, 'The specs do not agree');
    assert.ok(twice.lines.some((l) => l.includes('loaded twice')), twice.lines.join('\n'));
    // the client layer alone requires a document that is not loaded: a warning (an embed may show a subset), not an error
    const alone = checkSpecs(specEntries([client]));
    assert.equal(alone.ok, true);
    if (alone.ok) assert.ok(alone.warnings.some((w) => w.includes('sample-core.json')), alone.warnings.join('\n'));
});

test('the error onError gets: a title and the lines, the message joins them', () => {
    const e = mapError('Could not load the specs', ['a.json: HTTP 404']);
    assert.ok(e instanceof Error);
    assert.equal(e.title, 'Could not load the specs');
    assert.deepEqual(e.lines, ['a.json: HTTP 404']);
    assert.equal(e.message, 'Could not load the specs: a.json: HTTP 404');
});

// dom.ts is typed against the DOM (this project has none in `lib`): loaded through a specifier tsc does not follow
interface Prefs { get(k: string, d: boolean): boolean; set(k: string, on: boolean): void }
const DOM = '../viewer/src/dom.ts';
const { prefsOf } = (await import(DOM)) as { prefsOf: (key: string | false) => Prefs };

/** A localStorage stand-in that records every read and write. */
function stubStorage(t: { after(fn: () => void): void }) {
    const data = new Map<string, string>();
    const log: string[] = [];
    const g = globalThis as { localStorage?: unknown };
    const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
    Object.defineProperty(g, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => (log.push(`get ${k}`), data.get(k) ?? null),
            setItem: (k: string, v: string) => (log.push(`set ${k}=${v}`), data.set(k, v)),
        },
    });
    t.after(() => (had ? Object.defineProperty(g, 'localStorage', had) : delete g.localStorage));
    return { data, log };
}

test('preferences: archMap.<name> by default, the default until one is saved, "1"/"0" stored', (t) => {
    const { data } = stubStorage(t);
    const p = prefsOf('archMap');
    assert.equal(p.get('scDeep', true), true);
    p.set('scDeep', false);
    assert.equal(data.get('archMap.scDeep'), '0');
    assert.equal(p.get('scDeep', true), false);
    p.set('hintsSeen', true);
    assert.equal(data.get('archMap.hintsSeen'), '1');
});

test('preferences: a custom prefix keeps two maps apart; false never reads or writes', (t) => {
    const { data, log } = stubStorage(t);
    prefsOf('docsMap').set('scCamera', false);
    assert.deepEqual([...data.keys()], ['docsMap.scCamera']);
    assert.equal(prefsOf('archMap').get('scCamera', true), true, 'another prefix does not see it');
    log.length = 0;
    const none = prefsOf(false);
    none.set('scCamera', false);
    assert.equal(none.get('scCamera', true), true);
    assert.deepEqual(log, [], 'storageKey false touches no storage');
});

test('preferences: a storage that throws (a private window) gives the default', (t) => {
    stubStorage(t);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
    const p = prefsOf('archMap');
    assert.equal(p.get('scDeep', true), true);
    assert.doesNotThrow(() => p.set('scDeep', false));
});
