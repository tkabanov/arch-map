// The hover card's geometry (viewer/src/card-aim.ts): which side it takes beside its block, and the safe triangle that
// keeps it while the pointer heads for it. The browser check with real input: test/browser/hover.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSpot, spotCosts, coverCost, headingTo, inTriangle, nearCorners, centreOf, CENTRE_WEIGHT, type Box, type Spot } from '../viewer/src/card-aim.ts';

const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });
/** A 100×60 card beside a block at (400…500, 400…460): right, left, below, above (as card.ts builds them). */
const W = 100, H = 60;
const SPOTS: Spot[] = [
    { fits: true, x: 510, y: 400 },
    { fits: true, x: 290, y: 400 },
    { fits: true, x: 400, y: 470 },
    { fits: true, x: 400, y: 330 },
];

const pick = (spots: Spot[], blocks: Box[]) => chooseSpot(spotCosts(spots, W, H, blocks));

test('coverCost: nothing covered is 0; a block\'s middle counts CENTRE_WEIGHT times its share', () => {
    assert.equal(coverCost(box(0, 0, 10, 10), [box(20, 20, 40, 40)]), 0);
    // the card covers the whole block: share 1 + weight × 1
    assert.equal(coverCost(box(0, 0, 100, 100), [box(20, 20, 40, 40)]), 1 + CENTRE_WEIGHT);
    // a corner off the middle: only the share of the box
    const c = coverCost(box(0, 0, 24, 24), [box(20, 20, 60, 60)]);
    assert.ok(c > 0 && c < 0.02, String(c));
    assert.deepEqual(centreOf(box(0, 0, 40, 80)), box(10, 20, 30, 60));
});

test('chooseSpot: the first side that fits when every side is free (the order right, left, below, above stays)', () => {
    assert.equal(pick(SPOTS, []), 0);
    assert.equal(pick([{ ...SPOTS[0], fits: false }, ...SPOTS.slice(1)], []), 1);
    assert.equal(pick(SPOTS.map((s) => ({ ...s, fits: false })), []), -1);
});

test('chooseSpot: a neighbour\'s middle on the right sends the card to the left', () => {
    const right = box(520, 395, 600, 465); // its middle is under the right-hand spot
    assert.equal(pick(SPOTS, [right]), 1);
    // neighbours right and left: below
    assert.equal(pick(SPOTS, [right, box(280, 395, 380, 465)]), 2);
});

test('chooseSpot: grazing a big block\'s edge beats covering a small block\'s middle', () => {
    const smallRight = box(540, 420, 570, 440); // whole, middle and all, under the right spot
    const bigLeft = box(0, 300, 300, 700); // the left spot touches only its right edge
    assert.equal(pick([SPOTS[0], SPOTS[1]], [smallRight, bigLeft]), 1);
});

test('inTriangle: inside, on an edge, outside — either winding', () => {
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 }, c = { x: 0, y: 10 };
    assert.ok(inTriangle({ x: 2, y: 2 }, a, b, c));
    assert.ok(inTriangle({ x: 2, y: 2 }, a, c, b));
    assert.ok(inTriangle({ x: 5, y: 0 }, a, b, c));
    assert.ok(!inTriangle({ x: 8, y: 8 }, a, b, c));
});

test('nearCorners: the two corners that bound the card as seen from the point', () => {
    // from the left, level with the card: its left edge's corners
    assert.deepEqual(nearCorners({ x: 0, y: 50 }, box(100, 0, 200, 100)), [{ x: 100, y: 0 }, { x: 100, y: 100 }]);
    // from below-left: top-left and bottom-right
    const [p, q] = nearCorners({ x: 0, y: 300 }, box(100, 0, 200, 100));
    assert.deepEqual([p, q].sort((u, v) => u.x - v.x), [{ x: 100, y: 0 }, { x: 200, y: 100 }]);
});

test('headingTo: on the way to the card, on the card, or off the way', () => {
    const card = box(510, 380, 610, 440), from = { x: 498, y: 410 }; // left the block on its right edge
    assert.ok(headingTo({ x: 505, y: 410 }, from, card), 'straight towards it');
    assert.ok(headingTo({ x: 505, y: 400 }, from, card), 'slanting up towards its corner');
    assert.ok(headingTo({ x: 560, y: 400 }, from, card), 'on the card');
    assert.ok(!headingTo({ x: 498, y: 470 }, from, card), 'down, away from it');
    assert.ok(!headingTo({ x: 480, y: 410 }, from, card), 'back over the block');
});
