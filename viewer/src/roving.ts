// The keyboard's way over the blocks on the map (P1-2): the blocks drawn now, in reading order — rows from the top of
// the screen down, each row left to right — and where an arrow key goes from the block selected now. Pure: screen
// boxes in, ids out; no DOM, no three.js (map-keys.ts measures the boxes and acts).

/** A block on screen: its id and its box (client px). */
export interface ScreenBlock {
    id: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** The keys that move the keyboard selection. */
export type RoveKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';
export const ROVE_KEYS: ReadonlySet<string> = new Set<RoveKey>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

const cy = (b: ScreenBlock) => (b.y0 + b.y1) / 2;
const cx = (b: ScreenBlock) => (b.x0 + b.x1) / 2;

/**
 * The blocks in rows, top to bottom, each row left to right. A block joins the row above it while its middle is
 * within half the height of that row's first block (the smallest half, at least 8 px) of that block's middle — a row of
 * blocks of one level stands level on screen, a block a little lower or higher still reads with it.
 */
export function readingRows(blocks: ScreenBlock[]): ScreenBlock[][] {
    const rows: ScreenBlock[][] = [];
    for (const b of [...blocks].sort((p, q) => cy(p) - cy(q) || cx(p) - cx(q) || (p.id < q.id ? -1 : 1))) {
        const row = rows.at(-1), head = row?.[0];
        const reach = head ? Math.max(8, Math.min(head.y1 - head.y0, b.y1 - b.y0) / 2) : 0;
        if (row && head && cy(b) - cy(head) <= reach) row.push(b);
        else rows.push([b]);
    }
    for (const row of rows) row.sort((p, q) => cx(p) - cx(q) || (p.id < q.id ? -1 : 1));
    return rows;
}

/** The ids in reading order. */
export const readingOrder = (blocks: ScreenBlock[]): string[] => readingRows(blocks).flat().map((b) => b.id);

/**
 * Where `key` takes the keyboard selection from `current` (an id, or null / not among the blocks: nothing of them is
 * selected yet). → and ← go to the next and the previous block in reading order (across the end of a row, wrapping at
 * the ends); ↓ and ↑ to the block of the next or the previous row nearest across (on the last row ↓ stays, on the first ↑); Home and End
 * to the first and the last. With nothing selected yet, → ↓ Home take the first, ← ↑ End the last. Null: no blocks.
 */
export function rove(blocks: ScreenBlock[], current: string | null, key: RoveKey): string | null {
    const rows = readingRows(blocks), flat = rows.flat();
    if (!flat.length) return null;
    const i = flat.findIndex((b) => b.id === current);
    const back = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'End';
    if (i < 0 || key === 'Home' || key === 'End') return (back ? flat.at(-1)! : flat[0]).id;
    if (key === 'ArrowRight' || key === 'ArrowLeft') return flat[(i + (back ? -1 : 1) + flat.length) % flat.length].id;
    const r = rows.findIndex((row) => row.includes(flat[i]));
    const to = rows[r + (back ? -1 : 1)];
    if (!to) return flat[i].id;
    const x = cx(flat[i]);
    return to.reduce((best, b) => (Math.abs(cx(b) - x) < Math.abs(cx(best) - x) ? b : best)).id;
}

/** «3 of 7»: where `id` stands in reading order. */
export function placeOf(blocks: ScreenBlock[], id: string): string {
    const order = readingOrder(blocks);
    const i = order.indexOf(id);
    return i < 0 ? '' : `${i + 1} of ${order.length}`;
}
