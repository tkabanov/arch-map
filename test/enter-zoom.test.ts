// Entering a block (a double-click, «Enter ⤵» on the card or the panel, the Enter key) flies the camera in to the opened
// block, as the wheel does when it opens one — not out to the focus and every block at the other end of its relations
// (frameFocus, which going up, Leave and links keep). The browser check with real input: docs/browser-checks.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// focus.ts is typed against the app context (app.ts → the DOM-typed viewer); this project has no DOM in `lib`, so it is
// loaded through a specifier tsc does not follow (tsconfig.viewer.json type-checks focus.ts itself)
type SetFocus = (app: StubApp, id: string | null, opts?: { anchor?: boolean; select?: boolean; enter?: boolean }) => void;
interface StubApp { model: { nodes: Map<string, { children: unknown[] }> }; state: { focus: string | null } }
const FOCUS = '../viewer/src/focus.ts';
const { setFocus } = (await import(FOCUS)) as { setFocus: SetFocus };

/** sys › mod › (a, b); a stub app that records how the camera was told to move. */
function stubApp(rest: string[] = []) {
    const node = (id: string, parent: string | null, children: string[]) => ({ id, parent, children: children.map((c) => ({ id: c })) });
    const nodes = new Map([
        ['sys', node('sys', null, ['mod', 'other'])],
        ['mod', node('mod', 'sys', ['a', 'b'])],
        ['other', node('other', 'sys', [])],
        ['a', node('a', 'mod', [])],
        ['b', node('b', 'mod', [])],
    ]);
    const calls: string[] = [];
    const scene = {
        anchor: null as string | null,
        fitIds: (ids: Set<string>) => calls.push(`fitIds ${[...ids].join(',')}`),
        screenArea: () => 0.3,
        blocksInFrame: () => [],
    };
    const app = {
        model: { nodes },
        scene,
        state: { focus: null, all: false, upRef: null, path: null, selected: null },
        restSet: () => new Set(rest),
        relayout: () => calls.push('relayout'),
        frameFocus: () => calls.push('frameFocus'),
    } as unknown as StubApp;
    return { app, calls };
}

test('enter: the camera frames the opened block alone, after the relayout', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { app, calls } = stubApp();
    setFocus(app, 'mod', { enter: true });
    assert.equal(app.state.focus, 'mod');
    assert.deepEqual(calls, ['relayout', 'fitIds mod']);
});

test('enter on a block whose parent has only it: the focus (and the frame) is the outermost of the chain', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { app, calls } = stubApp();
    app.model.nodes.get('sys')!.children.pop(); // sys › mod only
    setFocus(app, 'mod', { enter: true });
    assert.equal(app.state.focus, 'sys');
    assert.deepEqual(calls, ['relayout', 'fitIds sys']);
});

test('without enter (going up, Leave, a link) the frame is frameFocus: the focus and its relations', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { app, calls } = stubApp();
    setFocus(app, 'mod');
    assert.deepEqual(calls, ['relayout', 'frameFocus']);
});

test('enter on what is open at rest leaves the focus at the overview: frameFocus fits the whole map', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { app, calls } = stubApp(['mod']);
    setFocus(app, 'mod', { enter: true });
    assert.equal(app.state.focus, null);
    assert.deepEqual(calls, ['relayout', 'frameFocus']);
});

test('anchor (the wheel opening a block) moves no camera here: the wheel flies itself', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { app, calls } = stubApp();
    setFocus(app, 'mod', { anchor: true, enter: true });
    assert.deepEqual(calls, ['relayout']);
});

test('every way to enter a block passes enter: double-click, «Enter ⤵» (card and panel), the Enter key', () => {
    const src = (f: string) => readFileSync(new URL(`../viewer/src/${f}`, import.meta.url), 'utf8');
    const map = src('map.ts'), actions = src('actions.ts'), keys = src('map-keys.ts');
    assert.match(map, /toggle: \(id: ElementId\) => \{[\s\S]*?app\.setFocus\(id, \{ enter: true \}\)/, 'double-click');
    assert.match(keys, /e\.key === 'Enter'\) return onEnter[\s\S]*?function onEnter[\s\S]*?app\.setFocus\(n\.id, \{ enter: true \}\)/, 'Enter key');
    assert.match(actions, /dataset\.focus !== undefined\) return app\.setFocus\([^)]*, \{ enter: true \}\)/, '«Enter ⤵» buttons (data-focus)');
    // data-focus is only ever an «Enter ⤵» button
    for (const f of ['card.ts', 'panel.ts']) for (const m of src(f).matchAll(/data-focus="[^"]*"[^>]*>([^<]*)</g)) assert.match(m[1], /Enter ⤵/, f);
});
