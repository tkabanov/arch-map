// Path follows `schedule` (2026-11-06): a scheduled method / endpoint is the next level, like `call` / `rest`; a step
// into a method still being walked (recursion) ends there with `cycle: true`. A small authored set for the rules. (The
// real sets are checked in the projects' own tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSpecs } from '../viewer/src/core/merge.ts';
import { trace } from '../viewer/src/core/path.ts';
import { callers } from '../viewer/src/core/queries.ts';
import type { ArchMapSpecDocument, Edge, Element } from '../types/spec.d.ts';

const comp = (id: string, methods: string[], extra: Partial<Element> = {}): Element =>
    ({ id, type: 'component', parent: 's.app', name: id, provenance: 'authored', methods: methods.map((name) => ({ name })), ...extra }) as Element;
const edge = (from: string, fromMethod: string, to: string, channel: Edge['channel'], toMethod?: string): Edge =>
    ({ id: `${from}#${fromMethod}>${to}#${toMethod ?? ''}:${channel}`, from, fromMethod, to, ...(toMethod ? { toMethod } : {}), channel, provenance: 'authored' }) as Edge;
const doc: ArchMapSpecDocument = {
    schemaVersion: '1.1.0',
    id: 'sched',
    title: 'Fixture: schedules',
    elements: [
        { id: 's.app', type: 'app', parent: null, name: 'App', provenance: 'authored' },
        { id: 's.db', type: 'table', parent: 's.app', name: 't', provenance: 'authored' },
        { id: 's.cron', type: 'job', parent: 's.app', name: 'cron', provenance: 'authored' },
        comp('s.page', ['click']),
        comp('s.wf', ['run']),
        comp('s.loop', ['again']),
        comp('s.fn', ['handle']),
        { id: 's.fn.post_x', type: 'endpoint', parent: 's.fn', name: 'POST /x', handler: 'handle', http: { method: 'POST', path: '/x' }, provenance: 'authored' } as Element,
    ] as Element[],
    edges: [
        edge('s.page', 'click', 's.wf', 'schedule', 'run'),
        edge('s.page', 'click', 's.loop', 'schedule', 'again'),
        edge('s.wf', 'run', 's.db', 'write'),
        edge('s.wf', 'run', 's.loop', 'schedule', 'again'),
        edge('s.loop', 'again', 's.loop', 'schedule', 'again'),
        edge('s.cron', 'nightly', 's.fn.post_x', 'schedule'),
        edge('s.fn', 'handle', 's.db', 'read'),
    ],
};
const m = mergeSpecs([{ name: 'sched.json', doc }], { strict: true });
const row = (s: { channel: string; to?: string; toMethod?: string; depth: number; cycle?: true }) => `${s.depth} ${s.channel} ${s.to}${s.toMethod ? `#${s.toMethod}` : ''}${s.cycle ? ' cycle' : ''}`;

test('fixture loads', () => assert.deepEqual(m.errors, []));

test('schedule with toMethod is the next level; a self-schedule ends with `cycle`; a method walked elsewhere is a plain leaf', () => {
    assert.deepEqual(trace(m, 's.page', 'click').map(row), [
        '1 schedule s.loop#again',
        '2 schedule s.loop#again cycle', // s.loop#again schedules itself
        '1 schedule s.wf#run',
        '2 write s.db',
        '2 schedule s.loop#again', // walked above, but not an ancestor here: a leaf, not a cycle
    ]);
});

test('a job rail scheduling an endpoint: the endpoint’s handler is the next level; the job stays a caller of it', () => {
    assert.deepEqual(trace(m, 's.cron', 'nightly').map(row), ['1 schedule s.fn.post_x', '2 read s.db']);
    assert.deepEqual(callers(m, 's.fn.post_x', { methods: true }), ['s.cron#nightly']);
});
