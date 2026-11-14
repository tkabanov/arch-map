// The figures of a block's relations, in one vocabulary for the hover card and the panel: who uses it and how often
// ("5 callers · 11 calls"), the tables it touches, what it talks to ("3 targets · 7 calls"); for a rail (a bus, a
// queue, jobs) "2 publishers · 9 published" and "4 subscribers · 12 delivered". Pure: no DOM, no three.js.
import { isRail } from './core/tier.ts';
import type { SummaryEntry } from '../../types/core.ts';
import type { ViewNode } from '../../types/viewer.ts';

/** One figure: a number and its unit (already singular or plural). */
export interface Figure {
    n: number;
    unit: string;
}

/** The figures of one block: who comes in, the tables, what goes out. */
export interface Figures {
    in: Figure[];
    tables: Figure;
    out: Figure[];
}

/** A summary's entry as the viewer has it: its owner is a view node (several core owners may fold into one). */
type Entry = Pick<SummaryEntry, 'n'> & { owner: { id: string } };

const fig = (n: number, one: string, many: string): Figure => ({ n, unit: n === 1 ? one : many });
/** Distinct owners: the summary groups by owner and channel, so one caller over two channels is two entries. */
const owners = (list: Entry[]) => new Set(list.map((g) => g.owner.id)).size;
const total = (list: Entry[]) => list.reduce((a, g) => a + g.n, 0);

/** The figures of a summary (`summary` in model.ts); `rail`: the block is a bus, a queue or jobs. */
export function relationFigures(s: { in: Entry[]; tables: Entry[]; out: Entry[] }, rail: boolean): Figures {
    return {
        in: rail ? [fig(owners(s.in), 'publisher', 'publishers'), fig(total(s.in), 'published', 'published')] : [fig(owners(s.in), 'caller', 'callers'), fig(total(s.in), 'call', 'calls')],
        tables: fig(owners(s.tables), 'table', 'tables'),
        out: rail ? [fig(owners(s.out), 'subscriber', 'subscribers'), fig(total(s.out), 'delivered', 'delivered')] : [fig(owners(s.out), 'target', 'targets'), fig(total(s.out), 'call', 'calls')],
    };
}

/** A summary as the viewer has it (`summary` in model.ts). */
type Sum = { in: Entry[]; tables: Entry[]; out: Entry[] };
/** A heading of the panel's summary: its title, its figures, the summary's list it heads. */
export interface Head {
    list: 'in' | 'tables' | 'out';
    title: string;
    figures: Figure[];
}

/** The panel's summary headings, in order: who uses it, the tables (not for a table or a rail), what it talks to. */
export function summaryHeads(n: Pick<ViewNode, 'type'>, s: Sum): Head[] {
    const rail = isRail(n); // a bus, a queue, jobs: what comes in is published, what goes out is delivered
    const f = relationFigures(s, rail);
    return [
        { list: 'in', title: rail ? 'Publishers' : 'Used by', figures: f.in },
        ...(n.type !== 'table' && !rail ? [{ list: 'tables' as const, title: 'Tables', figures: [f.tables] }] : []),
        { list: 'out', title: rail ? 'Subscribers' : 'Talks to', figures: f.out },
    ];
}

/** The hover card's figures: the panel's headings' (summaryHeads), with the endpoints after who uses it. */
export function cardFigures(n: Pick<ViewNode, 'type'>, s: Sum, endpoints: number): Figure[][] {
    const heads = summaryHeads(n, s).map((h) => h.figures);
    if (endpoints && !isRail(n)) heads.splice(1, 0, [fig(endpoints, 'endpoint', 'endpoints')]);
    return heads;
}

/** A block's own figures: the parts inside it (a block that has any), its endpoints (when it has some). The panel's
 * role line and the screen reader's selection status say them in these words. */
export function blockFigures(n: { children: unknown[]; leafCount: number }, endpoints: number): Figure[] {
    return [...(n.children.length ? [fig(n.leafCount, 'part', 'parts')] : []), ...(endpoints ? [fig(endpoints, 'endpoint', 'endpoints')] : [])];
}

/** Relations (raw, inside their folded lines) between placed blocks that are in scope but not drawn: a filter hides them. */
export function hiddenRelations(inScope: { id: string; from: string; to: string; raw: unknown[] }[], drawn: Set<string>, placed: Set<string>): number {
    let n = 0;
    for (const e of inScope) if (!drawn.has(e.id) && placed.has(e.from) && placed.has(e.to)) n += e.raw.length;
    return n;
}

/** Calls the generators could not follow (each method's `unresolved`): a Path shows each as a break. */
export function unresolvedCalls(elements: { methods?: { unresolved?: unknown[] }[] }[]): number {
    let n = 0;
    for (const el of elements) for (const m of el.methods ?? []) n += m.unresolved?.length ?? 0;
    return n;
}

/** The status line's figures, each with what it means: what the filters hide now, what the specs could not resolve; none that is 0. */
export function statusFigures(hidden: number, unresolved: number): { figure: Figure; why: string }[] {
    return [
        ...(hidden ? [{ figure: fig(hidden, 'relation hidden by filters', 'relations hidden by filters'), why: 'Turn their kinds on in the legend to draw them' }] : []),
        ...(unresolved ? [{ figure: fig(unresolved, 'unresolved call in the specs', 'unresolved calls in the specs'), why: 'Calls the generator could not follow to their target; a Path shows each as a break' }] : []),
    ];
}

/** "5 callers · 11 calls". */
export const figuresText = (list: Figure[]): string => list.map((f) => `${f.n} ${f.unit}`).join(' · ');
/** "<b>5</b> callers · <b>11</b> calls" (units are fixed words: nothing to escape). */
export const figuresHtml = (list: Figure[]): string => list.map((f) => `<b>${f.n}</b> ${f.unit}`).join(' · ');
