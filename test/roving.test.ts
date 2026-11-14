// The keyboard's way over the blocks on the map (viewer/src/roving.ts, P1-2): reading order — rows top to bottom, each
// left to right, a block a little higher or lower still in its row — and where each arrow key, Home and End go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingOrder, readingRows, rove, placeOf, type ScreenBlock } from '../viewer/src/roving.ts';

const box = (id: string, x: number, y: number, w = 80, h = 40): ScreenBlock => ({ id, x0: x, y0: y, x1: x + w, y1: y + h });
// two rows of three (the middle one of the first row 10 px lower, as a block seen at an angle), and one alone below
const grid = [box('c', 400, 100), box('a', 0, 100), box('b', 200, 110), box('f', 400, 300), box('d', 0, 300), box('e', 200, 290), box('g', 210, 500)];

test('reading order: rows top to bottom, each row left to right, whatever order the blocks come in', () => {
    assert.deepEqual(readingRows(grid).map((r) => r.map((b) => b.id)), [['a', 'b', 'c'], ['d', 'e', 'f'], ['g']]);
    assert.deepEqual(readingOrder([...grid].reverse()), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    assert.deepEqual(readingOrder([]), []);
});

test('a block lower by more than half its height starts a new row; tiny blocks keep 8 px of tolerance', () => {
    assert.deepEqual(readingRows([box('a', 0, 0), box('b', 100, 21)]).length, 2);
    assert.deepEqual(readingRows([box('a', 0, 0), box('b', 100, 19)]).length, 1);
    assert.deepEqual(readingRows([box('a', 0, 0, 10, 4), box('b', 20, 7, 10, 4)]).length, 1);
});

test('→ ← go through reading order across rows and wrap at the ends', () => {
    assert.equal(rove(grid, 'c', 'ArrowRight'), 'd');
    assert.equal(rove(grid, 'd', 'ArrowLeft'), 'c');
    assert.equal(rove(grid, 'g', 'ArrowRight'), 'a');
    assert.equal(rove(grid, 'a', 'ArrowLeft'), 'g');
});

test('↓ ↑ go to the nearest block across in the next or previous row; stay on the last and first row', () => {
    assert.equal(rove(grid, 'b', 'ArrowDown'), 'e');
    assert.equal(rove(grid, 'c', 'ArrowDown'), 'f');
    assert.equal(rove(grid, 'f', 'ArrowDown'), 'g');
    assert.equal(rove(grid, 'g', 'ArrowUp'), 'e');
    assert.equal(rove(grid, 'g', 'ArrowDown'), 'g');
    assert.equal(rove(grid, 'a', 'ArrowUp'), 'a');
});

test('Home and End, and the first key with nothing of the map selected (null, or the block you are in)', () => {
    assert.equal(rove(grid, 'e', 'Home'), 'a');
    assert.equal(rove(grid, 'e', 'End'), 'g');
    for (const k of ['ArrowRight', 'ArrowDown', 'Home'] as const) assert.equal(rove(grid, null, k), 'a', k);
    for (const k of ['ArrowLeft', 'ArrowUp', 'End'] as const) assert.equal(rove(grid, 'the-focus', k), 'g', k);
    assert.equal(rove([], null, 'ArrowRight'), null);
});

test('placeOf says where a block stands: «2 of 7»', () => {
    assert.equal(placeOf(grid, 'b'), '2 of 7');
    assert.equal(placeOf(grid, 'nope'), '');
});
