// Places visible nodes in horizontal layers, one per tier of the merged set (model.tiers), and in columns, one per root
// (AD-11). A collapsed node is a block; an expanded one is a plate whose children are shelf-packed on top of it; an
// expanded system is a column. A cross-cutting element (bus, queue, job) is neither: it is a rail across its
// column's front edge just below its tier, seen once the block that holds it is open. Units are world units: x/z on the floor, y up.
import { isRail } from './core/tier.ts';
import type { Tier, TierId, ElementId } from '../../types/spec.d.ts';
import type { Model, PlacedNode, Point3, Size3, ViewNode } from '../../types/viewer.ts';

/** One closed outside system or one part of a column, with its measured size. */
interface Item {
    n: ViewNode;
    s: Size3;
}
/** The parts of a column on one tier. */
interface Cell {
    items: Item[];
    w: number;
    d: number;
    h: number;
}
/** A column: one root (open or closed) … */
interface Column {
    grid?: false;
    r: ViewNode;
    open: boolean;
    cells: Map<TierId, Cell>;
    rails: ViewNode[];
    w: number;
}
/** … or the grid of closed outside systems. */
interface Grid {
    grid: true;
    items: Item[];
    perRow: number;
    cellW: number;
    cellD: number;
    w: number;
    d: number;
    tier: TierId;
    rails: ViewNode[];
    cells: Map<TierId, Cell>;
}
/** A layer plate under the blocks of one tier. */
export interface Plate {
    layer: Tier;
    y: number;
    w: number;
    d: number;
    /** scene-layout.ts: the world offset (the block the wheel opened stays where it was). */
    ox?: number;
    oz?: number;
}

const LEAF = { w: 8, d: 6.5 };
const COLLAPSED = { w: 11, d: 8 };
const PAD = 1.6;
const HEADER = 3.2; // strip at the back edge of a plate for its title
const PLATE = 0.35;
const GAP = 1.4;
// the client layer (AD-11): roots are larger tiles, spread out like a picture
const CLIENT: Record<string, { w: number; d: number }> = { system: { w: 26, d: 18 }, actor: { w: 15, d: 11 }, 'external-system': { w: 17, d: 12 } };
const COL_GAP = 7; // between columns
const CELL_GAP = GAP * 3; // between the parts of an expanded system on one tier
const ACTOR_GAP = 14;
const COL_PAD = 2.2; // outline of an expanded system around its parts
const COL_TOP = 9; // the column's title floats above its parts
// a rail: depth, height, spacing of parallel rails, overhang at each end, distance in front of the column, drop below its tier
const RAIL = { d: 2.2, h: 0.7, gap: 4.5, over: 1.8, front: 3, drop: 0.35 };

const blockHeight = (n: ViewNode): number => {
    if (n.type === 'table') return 0.9 + Math.min(2.4, (n.columns?.length ?? 0) * 0.08);
    if (n.endpoints?.length) return 1 + Math.min(4, n.endpoints.length * 0.14);
    if (n.children.length) return 1.2 + Math.min(3.5, Math.log2(1 + n.leafCount) * 0.55);
    return 0.8 + Math.min(3, Math.log2(1 + n.degree) * 0.45);
};

/** a closed block with parts grows with how much it holds (log of its leaves, at most twice): an app of 400 parts
 *  does not look like one of three, and reaches the size that opens it sooner */
const grown = (n: ViewNode): { w: number; d: number } => {
    const k = Math.min(2, 1 + Math.log2(1 + (n.leafCount ?? 1)) / 8);
    return { w: COLLAPSED.w * k, d: COLLAPSED.d * k };
};

function measure(n: ViewNode, expanded: Set<ElementId>): Size3 {
    if (!expanded.has(n.id) || !n.children.length) {
        // «Outside the slice» is context: a small, low block that does not compete with the slice
        const s = n.type === 'group' ? { w: 7, d: 5 } : (!n.parent && CLIENT[n.type]) || (n.children.length ? grown(n) : LEAF);
        n._size = { w: s.w, d: s.d, h: n.type === 'group' ? 0.9 : blockHeight(n) };
        n._plate = false;
        n._column = false;
        return n._size;
    }
    // rails are not packed on the board: they run under it (layout)
    const kids = n.children.filter((c) => !isRail(c)).map((c) => ({ c, s: measure(c, expanded) }));
    const area = kids.reduce((a, k) => a + (k.s.w + GAP) * (k.s.d + GAP), 0);
    const target = Math.max(Math.sqrt(area) * 1.35, LEAF.w, ...kids.map((k) => k.s.w));
    let x = 0, z = 0, rowD = 0, maxW = 0;
    for (const k of kids) {
        if (x > 0 && x + k.s.w > target) {
            z += rowD + GAP;
            x = 0;
            rowD = 0;
        }
        k.c._rel = { x, z };
        x += k.s.w + GAP;
        rowD = Math.max(rowD, k.s.d);
        maxW = Math.max(maxW, x - GAP);
    }
    n._size = { w: (kids.length ? maxW : LEAF.w) + PAD * 2, d: z + rowD + PAD * 2 + HEADER, h: PLATE };
    n._plate = true;
    n._column = false;
    return n._size;
}

function place(n: ViewNode, x: number, z: number, y: number, expanded: Set<ElementId>, out: ViewNode[]): void {
    n._pos = { x, y, z }; // min corner on the floor, y = bottom
    out.push(n);
    if (!n._plate) return;
    for (const c of n.children) if (!isRail(c)) place(c, x + PAD + c._rel!.x, z + PAD + HEADER + c._rel!.z, y + PLATE, expanded, out);
}

/** Rails seen inside root `r`: those whose parent is open (r open as a column or a board, and so on down). */
function railsIn(r: ViewNode, open: boolean, expanded: Set<ElementId>): ViewNode[] {
    const out: ViewNode[] = [];
    const walk = (n: ViewNode) => {
        for (const c of n.children) {
            if (isRail(c)) out.push(c);
            else if (expanded.has(c.id) && c.children.length) walk(c);
        }
    };
    if (open || expanded.has(r.id)) walk(r);
    return out;
}

/**
 * Rails from x0 to x1 along the front edge of their column (z from `zFront` outward, parallel ones a little apart), a
 * little below their tier: out of the column's footprint, so the lines down to the data tier do not run through them,
 * and on the side the camera looks from.
 */
function placeRails(rails: ViewNode[], x0: number, x1: number, zFront: number, yOf: Map<TierId, number>, layerGap: number, out: ViewNode[]): void {
    rails.forEach((n, i) => {
        const y = (yOf.get(n.layer) ?? 0) - layerGap * RAIL.drop;
        const z = zFront + RAIL.front + RAIL.d / 2 + i * RAIL.gap;
        n._size = { w: x1 - x0 + RAIL.over * 2, h: RAIL.h, d: RAIL.d };
        n._pos = { x: x0 - RAIL.over, y: y - RAIL.h / 2, z: z - RAIL.d / 2 };
        n._plate = false;
        n._column = false;
        n._rail = true;
        n._railIndex = i; // parallel rails name themselves at alternate ends
        out.push(n);
    });
}

const GRID_MIN = 5; // from this many closed outside systems they share one grid
/** closed outside systems as one column: rows of ⌈√n⌉ on their tier, in document order */
function gridColumn(list: ViewNode[], expanded: Set<ElementId>): Grid {
    const items = list.map((n) => ({ n, s: measure(n, expanded) }));
    const perRow = Math.ceil(Math.sqrt(items.length));
    const rows = Math.ceil(items.length / perRow);
    const cellW = Math.max(...items.map((x) => x.s.w)), cellD = Math.max(...items.map((x) => x.s.d));
    const w = perRow * cellW + (perRow - 1) * CELL_GAP, d = rows * cellD + (rows - 1) * CELL_GAP;
    const tier = list[0].layer;
    return { grid: true, items, perRow, cellW, cellD, w, d, tier, rails: [], cells: new Map([[tier, { items, w, d, h: Math.max(...items.map((x) => x.s.h)) }]]) };
}

/**
 * AD-11. Layers top-down (model.tiers: by default people, ui, service, data); actors form one centered row on the
 * people layer; every other root is a column, in document order. A collapsed root is one block on its tier; an expanded
 * system shows its children in the cell of each child's tier, all cells sharing the column's x-range, and is itself
 * placed as a thin column outline (`_column`) around them. Rails run along their column's front below their tier; a
 * root-level rail runs across the whole map. Empty layers take no room.
 * Returns placed nodes and the layer plates.
 */
export function layout(model: Model, expanded: Set<ElementId>, layerGap: number): { placed: PlacedNode[]; plates: Plate[] } {
    const placed: ViewNode[] = [];
    const actors = model.roots.filter((r) => r.type === 'actor');
    const rootRails = model.roots.filter((r) => isRail(r));
    // many closed outside systems: one compact grid where the first of them stands, not a column each
    const outside = model.roots.filter((r) => r.type === 'external-system' && !(expanded.has(r.id) && r.children.length));
    const grid = outside.length >= GRID_MIN ? gridColumn(outside, expanded) : null;
    const cols = model.roots
        .filter((r) => r.type !== 'actor' && !isRail(r) && !(grid && outside.includes(r) && r !== outside[0]))
        .map((r): Column | Grid => {
            if (grid && r === outside[0]) return grid;
            const open = r.type === 'system' && expanded.has(r.id) && r.children.length > 0;
            const cells = new Map<TierId, Cell>(); // tier → { items: [{ n, s }], w, d, h }
            for (const n of open ? r.children.filter((c) => !isRail(c)) : [r]) {
                const s = measure(n, expanded);
                const c = cells.get(n.layer) ?? cells.set(n.layer, { items: [], w: -CELL_GAP, d: 0, h: 0 }).get(n.layer)!;
                c.items.push({ n, s });
                c.w += s.w + CELL_GAP;
                c.d = Math.max(c.d, s.d);
                c.h = Math.max(c.h, s.h);
            }
            return { r, open, cells, rails: railsIn(r, open, expanded), w: Math.max(...[...cells.values()].map((c) => c.w)) };
        });
    const tiers = model.tiers;
    const used = tiers.filter((l) => (l.id === 'people' && actors.length) || cols.some((c) => c.cells.has(l.id)) || rootRails.some((n) => n.layer === l.id));
    const yOf = new Map<TierId, number>(used.map((l, i) => [l.id, (used.length - 1 - i) * layerGap]));
    const totalW = cols.reduce((a, c) => a + c.w, 0) + COL_GAP * Math.max(0, cols.length - 1);
    const depth = new Map<TierId, number>(used.map((l) => [l.id, 0]));

    // actors: one centered row
    let rowW = 0;
    if (actors.length) {
        const sizes = actors.map((a) => measure(a, expanded));
        rowW = sizes.reduce((a, s) => a + s.w, 0) + ACTOR_GAP * (actors.length - 1);
        let x = -rowW / 2;
        actors.forEach((a, i) => {
            place(a, x, -sizes[i].d / 2, yOf.get('people')!, expanded, placed);
            x += sizes[i].w + ACTOR_GAP;
            depth.set('people', Math.max(depth.get('people')!, sizes[i].d));
        });
    }
    // columns
    let x0 = -totalW / 2;
    for (const col of cols) {
        if (col.grid) {
            const y = yOf.get(col.tier)!;
            col.items.forEach(({ n }, i) => {
                const row = Math.floor(i / col.perRow), k = i % col.perRow;
                place(n, x0 + k * (col.cellW + CELL_GAP), -col.d / 2 + row * (col.cellD + CELL_GAP), y, expanded, placed);
            });
            depth.set(col.tier, Math.max(depth.get(col.tier)!, col.d));
            x0 += col.w + COL_GAP;
            continue;
        }
        let maxD = 0, yLow = Infinity, yHigh = -Infinity;
        for (const [tier, c] of col.cells) {
            const y = yOf.get(tier)!;
            let x = x0 + (col.w - c.w) / 2;
            for (const { n, s } of c.items) {
                place(n, x, -s.d / 2, y, expanded, placed);
                x += s.w + CELL_GAP;
            }
            depth.set(tier, Math.max(depth.get(tier)!, c.d));
            maxD = Math.max(maxD, c.d);
            yLow = Math.min(yLow, y);
            yHigh = Math.max(yHigh, y + c.h);
        }
        placeRails(col.rails, x0, x0 + col.w, maxD / 2 + (col.open ? COL_PAD : 0), yOf, layerGap, placed);
        // the column's outline takes its rails in: they are part of the system, on its front
        const front = col.rails.length ? RAIL.front + RAIL.d + (col.rails.length - 1) * RAIL.gap + 1 : 0;
        for (const n of col.rails) yLow = Math.min(yLow, n._pos!.y);
        if (col.open) {
            // the expanded system: an outline around its cells, with its title on top
            const r = col.r;
            r._pos = { x: x0 - COL_PAD, y: yLow - 0.6, z: -maxD / 2 - COL_PAD };
            r._size = { w: col.w + COL_PAD * 2, h: yHigh - yLow + 0.6 + COL_TOP, d: maxD + COL_PAD * 2 + front };
            r._plate = true;
            r._column = true;
            placed.push(r);
        }
        x0 += col.w + COL_GAP;
    }
    const width = Math.max(totalW, rowW);
    placeRails(rootRails, -width / 2, width / 2, Math.max(0, ...depth.values()) / 2, yOf, layerGap, placed);
    const plateW = width + 16;
    const plates = used.map((layer) => ({ layer, y: yOf.get(layer.id)!, w: plateW, d: depth.get(layer.id)! + 16 }));
    return { placed: placed as PlacedNode[], plates }; // place() and placeRails() set every placed node's size and position
}

export const center = (n: PlacedNode): Point3 => ({ x: n._pos.x + n._size.w / 2, y: n._pos.y + n._size.h, z: n._pos.z + n._size.d / 2 });
export const bottom = (n: PlacedNode): Point3 => ({ x: n._pos.x + n._size.w / 2, y: n._pos.y, z: n._pos.z + n._size.d / 2 });
