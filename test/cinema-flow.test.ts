import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cinemaEventFork, planCinema } from '../viewer/src/cinema-flow.ts';
import type { Model, ScenarioStep, ViewEdge } from '../types/viewer.ts';

const edge = (from: string, to: string, kind: ViewEdge['kind'] = 'https', extra: Partial<ViewEdge> = {}): ViewEdge => ({ id: `${from}>${to}`, from, to, kind, group: 'rest', title: '', items: [], ops: [], access: null, contract: null, provenance: 'authored', via: [], ...extra });
const step = (e: ViewEdge): Extract<ScenarioStep, {kind: 'edge'}> => ({ kind: 'edge', from: e.from, to: e.to, channel: e.kind, edges: [e], caption: e.id, duration: null, contract: e.contract });
const processing = (element: string): ScenarioStep => ({ kind: 'element', element, edges: [], caption: element, duration: null });
const model = (edges: ViewEdge[]): Model => ({ edges, nodes: new Map(), nodeOf: (id: string) => id }) as Model;
const route = (steps: ScenarioStep[], edges = steps.flatMap((s) => s.edges)) => planCinema(model(edges), steps).legs;
const describe = (legs: ReturnType<typeof route>) => legs.map((leg) => `${leg.kind}:${leg.from}>${leg.to}`);

test('nested processing returns before save and outer return after save; final calls unwind', () => {
    const outer = edge('app', 'server'), external = edge('server', 'external'), save = edge('server', 'db', 'write');
    const legs = route([step(outer), step(external), processing('external'), step(save), processing('app')]);
    assert.deepEqual(describe(legs), ['request:app>server', 'request:server>external', 'processing:external>external', 'response:external>server', 'request:server>db', 'response:db>server', 'response:server>app', 'processing:app>app']);
    assert.equal(legs[3].contract, null);
    assert.deepEqual(describe(route([step(outer), step(external)])), ['request:app>server', 'request:server>external', 'response:external>server', 'response:server>app']);
});

test('authored reverse steps consume pending calls once and preserve the request contract override', () => {
    const request = edge('a', 'b'), reverse = edge('b', 'a');
    const authored = { ...step(request), contract: { doc: 'objects.json', response: '#/Result' } };
    const legs = route([authored, step(reverse)]);
    assert.deepEqual(describe(legs), ['request:a>b', 'response:b>a']);
    assert.deepEqual(legs[1].contract, authored.contract);
});

test('an unambiguous supported continuation reaches processing; alternate paths are disclosed', () => {
    const request = edge('a', 'b'), save = edge('b', 'db', 'write');
    assert.deepEqual(describe(route([step(request), processing('db')], [request, save])), ['request:a>b', 'request:b>db', 'processing:db>db', 'response:db>b', 'response:b>a']);
    const alternate = edge('b', 'db', 'read');
    assert.ok(route([step(request), processing('db')], [request, save, alternate]).some((leg) => leg.kind === 'unspecified'));
    const ambiguous = route([step(request), processing('db')], [request, save, alternate]);
    assert.ok(ambiguous.findIndex((leg) => leg.kind === 'response' && leg.to === 'a') > ambiguous.findIndex((leg) => leg.kind === 'processing' && leg.to === 'db'));
});

test('topic-specific events retain authored branches, use camera attention between them, and never reply', () => {
    const pub = edge('publisher', 'bus', 'event', { toMethod: 'Paid' });
    const first = edge('bus', 'registration', 'event', { fromMethod: 'Paid' });
    const second = edge('bus', 'notification', 'event', { fromMethod: 'Paid' });
    const wrong = edge('bus', 'wrong', 'event', { fromMethod: 'Refunded' });
    const save = edge('registration', 'table', 'write');
    const mail = edge('notification', 'mail', 'smtp');
    const legs = route([step(pub), step(save), step(mail)], [pub, first, second, wrong, save, mail]);
    assert.deepEqual(describe(legs), ['delivery:publisher>bus', 'delivery:bus>registration', 'request:registration>table', 'response:table>registration', 'attention:registration>bus', 'delivery:bus>notification', 'request:notification>mail']);
    assert.ok(!legs.some((leg) => leg.to === 'wrong' || (leg.kind === 'response' && leg.to === 'publisher')));
    const missing = route([step(pub), step(edge('wrong', 'other', 'smtp'))], [pub, wrong]);
    assert.ok(missing.some((leg) => leg.kind === 'unspecified'));
});

test('disconnected authored actions are explicit and non-request channels never auto-return', () => {
    for (const kind of ['event', 'webhook', 'schedule', 'import', 'interacts'] as const) {
        assert.deepEqual(describe(route([step(edge('a', 'b', kind))])), [`${kind === 'event' ? 'delivery' : 'request'}:a>b`]);
    }
    const legs = route([processing('person'), processing('other'), step(edge('unknown', 'destination'))]);
    assert.ok(legs.some((leg) => leg.kind === 'unspecified'));
    const independentModel = model([]);
    independentModel.nodes.set('actor', { id: 'actor', type: 'actor' } as never);
    assert.ok(planCinema(independentModel, [processing('a'), processing('actor')]).legs.some((leg) => leg.kind === 'independent'));
});

test('bounded search stops at cycles and over-depth chains without inventing a route', () => {
    const edges = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => edge(id, ['b', 'c', 'd', 'e', 'f', 'target'][i], 'call'));
    edges.push(edge('c', 'b', 'call'));
    const legs = route([processing('a'), processing('target')], edges);
    assert.deepEqual(describe(legs), ['processing:a>a', 'unspecified:a>target', 'processing:target>target']);
});

test('a missing internal handler-to-helper connection retains the outer call until sibling save finishes', () => {
    const outer = edge('client', 'handler'), external = edge('helper', 'external'), save = edge('save', 'db', 'write');
    const fixture = model([outer, external, save]);
    for (const id of ['handler', 'helper', 'save']) fixture.nodes.set(id, { id, type: 'component', parent: 'operation' } as never);
    fixture.nodes.set('operation', { id: 'operation', type: 'module', parent: 'server' } as never);
    fixture.nodes.set('nested', { id: 'nested', type: 'module', parent: 'operation' } as never);
    fixture.nodes.get('save')!.parent = 'nested';
    const legs = planCinema(fixture, [step(outer), step(external), step(save), processing('client')]).legs;
    assert.deepEqual(describe(legs), ['request:client>handler', 'unspecified:handler>helper', 'request:helper>external', 'response:external>helper', 'unspecified:helper>save', 'request:save>db', 'response:db>save', 'unspecified:save>handler', 'response:handler>client', 'processing:client>client']);
    assert.ok(legs.findIndex((leg) => leg.kind === 'response' && leg.to === 'client') > legs.findIndex((leg) => leg.to === 'db'));
});

test('an authored reverse webhook or event is not mistaken for a synchronous response', () => {
    for (const kind of ['webhook', 'event', 'schedule', 'interacts', 'import'] as const) {
        const request = edge('client', 'server');
        const callback = edge('server', 'client', kind);
        const legs = route([step(request), step(callback)]);
        assert.equal(legs[1].kind, kind === 'event' ? 'delivery' : 'request');
        assert.ok(!legs.some((leg) => leg.kind === 'response' && leg.edge === callback));
    }
});

test('an unresolved reverse non-sync or unknown-channel action does not consume a pending call', () => {
    for (const channel of ['webhook', 'event', 'schedule', 'interacts', 'import', null] as const) {
        const request = edge('client', 'server');
        const reverse: ScenarioStep = { kind: 'edge', from: 'server', to: 'client', channel, edges: [], caption: 'Another action', duration: null, contract: null };
        const legs = route([step(request), reverse]);
        assert.equal(legs[1].kind, 'unspecified');
        assert.ok(legs.findIndex((leg) => leg.kind === 'response') > 1, 'the reverse action did not consume the pending call');
    }
});

test('an authored actor switch closes the preceding sequence before bounded graph search', () => {
    const request = edge('client', 'handler');
    const graph = [request, ...Array.from({ length: 300 }, (_, i) => edge('handler', `helper${i}`, 'call'))];
    const fixture = model(graph);
    fixture.nodes.set('reviewer', { id: 'reviewer', type: 'actor', parent: null } as never);
    const legs = planCinema(fixture, [step(request), processing('reviewer')]).legs;
    assert.deepEqual(describe(legs), ['request:client>handler', 'response:handler>client', 'independent:client>reviewer', 'processing:reviewer>reviewer']);
    const boundary = legs.findIndex((leg) => leg.kind === 'independent');
    assert.ok(!legs.slice(boundary).some((leg) => leg.kind === 'response'));
});

test('a known caller continues after a return, even when a graph edge points back to it', () => {
    const request = edge('a', 'b'), next = edge('a', 'c'), back = edge('b', 'a', 'call');
    assert.deepEqual(describe(route([step(request), step(next)], [request, next, back])), ['request:a>b', 'response:b>a', 'request:a>c', 'response:c>a']);
});

test('an ambiguous alternative subscriber cannot make another branch look uniquely causal', () => {
    const publication = edge('publisher', 'bus', 'event', { toMethod: 'Paid' });
    const subscriptions = ['one', 'two'].map((to) => edge('bus', to, 'event', { fromMethod: 'Paid' }));
    const graph = [publication, ...subscriptions, edge('one', 'target', 'call'), edge('two', 'target', 'call'), edge('two', 'helper', 'call'), edge('helper', 'target', 'call')];
    const legs = route([step(publication), processing('target')], graph);
    assert.ok(legs.some((leg) => leg.kind === 'unspecified'));
    assert.ok(!legs.some((leg) => leg.kind === 'delivery' && leg.from === 'bus'));
});

test('multiple publications of one topic disclose ambiguous delivery instead of selecting the latest', () => {
    const first = edge('one', 'bus', 'event', { toMethod: 'Paid' });
    const second = edge('two', 'bus', 'event', { toMethod: 'Paid' });
    const handler = edge('bus', 'handler', 'event', { fromMethod: 'Paid' });
    const legs = route([step(first), step(second), processing('handler')], [first, second, handler]);
    assert.ok(!legs.some((leg) => leg.kind === 'delivery' && leg.to === 'handler'));
    assert.ok(legs.some((leg) => leg.kind === 'unspecified' && leg.to === 'handler'));
});

test('a new authored interface action starts a participant boundary despite a graph connection', () => {
    const request = edge('client', 'server'), link = edge('server', 'other-screen', 'call');
    const fixture = model([request, link]);
    fixture.nodes.set('other-screen', { id: 'other-screen', type: 'component', parent: 'other-app', layer: 'ui' } as never);
    fixture.nodes.set('other-app', { id: 'other-app', type: 'app', layer: 'ui' } as never);
    const legs = planCinema(fixture, [step(request), processing('other-screen')]).legs;
    assert.deepEqual(describe(legs), ['request:client>server', 'response:server>client', 'independent:client>other-screen', 'processing:other-screen>other-screen']);
});

test('only the active event topic lights its authored subscriber fork', () => {
    const first = edge('publisher', 'bus', 'event', { toMethod: 'Paid' });
    const sub = edge('bus', 'handler', 'event', { fromMethod: 'Paid', toMethod: 'onPaid' });
    const other = edge('other', 'bus', 'event', { toMethod: 'Refunded' });
    const otherSub = edge('bus', 'other-handler', 'event', { fromMethod: 'Refunded', toMethod: 'onRefunded' });
    const save = edge('handler', 'db', 'write'), later = edge('other-handler', 'archive', 'write');
    const fixture = model([first, sub, other, otherSub, save, later]);
    fixture.nodes.set('bus', { id: 'bus', type: 'bus' } as never);
    const plan = planCinema(fixture, [processing('start'), step(first), step(save), step(other), step(later)]);
    assert.deepEqual(cinemaEventFork(fixture, plan, plan.legs[0]), []);
    const publication = plan.legs.find((leg) => leg.edge === first)!;
    const second = plan.legs.find((leg) => leg.edge === other)!;
    assert.deepEqual(cinemaEventFork(fixture, plan, publication).map((leg) => leg.edge?.id), [first.id, sub.id]);
    assert.deepEqual(cinemaEventFork(fixture, plan, second).map((leg) => leg.edge?.id), [other.id, otherSub.id]);
    const overview = { ...publication, kind: 'attention' as const, from: 'bus', to: 'bus', edge: undefined };
    assert.deepEqual(cinemaEventFork(fixture, plan, overview).map((leg) => leg.edge?.id), [first.id, sub.id]);
});

test('a depth-limited continuation cannot complete an outer call before its processing', () => {
    const request = edge('client', 'a');
    const graph = [request, ...['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => edge(id, ['b', 'c', 'd', 'e', 'f', 'db'][i], 'call'))];
    const legs = route([step(request), processing('db')], graph);
    const processed = legs.findIndex((leg) => leg.kind === 'processing' && leg.to === 'db');
    const returned = legs.findIndex((leg) => leg.kind === 'response' && leg.to === 'client');
    assert.ok(processed >= 0 && returned > processed);
    assert.ok(legs.some((leg) => leg.kind === 'unspecified'));
});
