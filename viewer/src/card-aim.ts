// Where the hover card goes and whether the pointer is on its way to it — screen geometry only, kept free of three.js
// and the DOM so it can be tested in node (test/hover-card.test.ts). main.ts places and keeps the card with it.
//
// Placement: the card stands beside its own block (right, left, below, above); of the sides that fit, it takes the one
// that covers least of the other blocks on screen, their middle (where a pointer rests to pick one) counting most.
// Keeping: the safe triangle (menu-aim). When the pointer leaves the card's block, the card stays only while the pointer
// heads for it — inside the triangle from where it left the block to the card's near corners. Anywhere else the card
// gives way at once to the block under the pointer.

/** A screen box (px): left, top, right, bottom. */
export interface Box { x0: number; y0: number; x1: number; y1: number }
/** A screen point (px). */
export interface Pt { x: number; y: number }
/** One side the card may take: whether it fits on the map, and the card's top-left corner there. */
export interface Spot { fits: boolean; x: number; y: number }

/** The middle of a block (as `atCentre` in scene-pick.ts: the middle half each way) counts this many times its area. */
export const CENTRE_WEIGHT = 4;
/** Costs closer than this are a tie: the earlier side (right, left, below, above) wins. */
const TIE = 1e-6;
/** The triangle starts this far behind the point where the pointer left the block: a hand does not move in a line. */
export const AIM_SLACK = 8;
/** The pointer may rest this long inside the triangle (not on the card) before the card gives way to what is under it. */
export const AIM_GRACE_MS = 350;

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** The middle half (each way) of a box. */
export function centreOf(b: Box): Box {
    const qx = (b.x1 - b.x0) / 4, qy = (b.y1 - b.y0) / 4;
    return { x0: b.x0 + qx, y0: b.y0 + qy, x1: b.x1 - qx, y1: b.y1 - qy };
}

/**
 * How much of the blocks a card at `card` covers: per block, the share of its box under the card plus CENTRE_WEIGHT
 * times the share of its middle. A share, not pixels: a small block covered whole weighs more than a corner of a big one.
 */
export function coverCost(card: Box, blocks: Box[]): number {
    let cost = 0;
    for (const b of blocks) {
        const a = area(b);
        if (!a || !overlap(card, b)) continue;
        const c = centreOf(b);
        cost += overlap(card, b) / a + (CENTRE_WEIGHT * overlap(card, c)) / Math.max(1e-9, area(c));
    }
    return cost;
}

/** What each spot would cover (coverCost), null where the card does not fit. */
export function spotCosts(spots: Spot[], w: number, h: number, blocks: Box[]): (number | null)[] {
    return spots.map((s) => (s.fits ? coverCost({ x0: s.x, y0: s.y, x1: s.x + w, y1: s.y + h }, blocks) : null));
}

/** The side for a `w`×`h` card: the fitting spot that covers least (`costs` from spotCosts), the first on a tie; -1 when none fits. */
export function chooseSpot(costs: (number | null)[]): number {
    let best = -1, bestCost = Infinity;
    costs.forEach((cost, i) => {
        if (cost === null || cost >= bestCost - TIE) return;
        best = i;
        bestCost = cost;
    });
    return best;
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** `p` inside the triangle a, b, c (edges included), whichever way round it is. */
export function inTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
}

export const inBox = (p: Pt, b: Box) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

/** The two corners of `box` that bound it as seen from `from` (the widest angle between them): the triangle's far side. */
export function nearCorners(from: Pt, box: Box): [Pt, Pt] {
    const cs: Pt[] = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }];
    let pair: [Pt, Pt] = [cs[0], cs[2]], widest = -1;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        const a = Math.atan2(cs[i].y - from.y, cs[i].x - from.x), b = Math.atan2(cs[j].y - from.y, cs[j].x - from.x);
        let d = Math.abs(a - b);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d <= widest) continue;
        widest = d;
        pair = [cs[i], cs[j]];
    }
    return pair;
}

/**
 * The pointer at `p` is on its way to the card `card`, having left its block at `from`: on the card, or inside the
 * triangle from `from` (moved AIM_SLACK back, away from the card) to the card's near corners.
 */
export function headingTo(p: Pt, from: Pt, card: Box): boolean {
    if (inBox(p, card)) return true;
    const cx = (card.x0 + card.x1) / 2, cy = (card.y0 + card.y1) / 2;
    const d = Math.hypot(cx - from.x, cy - from.y) || 1;
    const back = { x: from.x - ((cx - from.x) / d) * AIM_SLACK, y: from.y - ((cy - from.y) / d) * AIM_SLACK };
    const [a, b] = nearCorners(back, card);
    return inTriangle(p, back, a, b);
}
