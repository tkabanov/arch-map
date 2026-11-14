// The hover card: shown after a short pause, stays while the pointer is on it or on its way to it (the safe triangle,
// card-aim.ts); anywhere else it gives way at once to what is under the pointer. One per map (its state is `Card`).
import { summary } from './model.ts';
import { esc } from './scene-util.ts';
import { tag, cardStatsHtml } from './panel.ts';
import { isRail } from './core/tier.ts';
import { later, cancel } from './dom.ts';
import { chooseSpot, spotCosts, headingTo, inBox, AIM_GRACE_MS, type Box, type Spot } from './card-aim.ts';
import type { App } from './app.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { Hit, ScreenPoint } from '../../types/scene.ts';

/** A map's card and what it remembers between pointer events. */
export interface Card {
    el: HTMLElement & { pinned?: boolean };
    hoverTimer: number;
    hideTimer: number;
    aimTimer: number;
    /** The block whose card is up (null when hidden), and where the pointer was last seen on it. */
    of: ElementId | null;
    onBlockAt: ScreenPoint | null;
}

const SIDES = ['right', 'left', 'below', 'above'] as const;

/** The card of the map: the pointer over it keeps it, off it lets it go; the wheel over it belongs to the map. */
export function setupCard(app: App): Card {
    const c: Card = { el: app.$('#card'), hoverTimer: 0, hideTimer: 0, aimTimer: 0, of: null, onBlockAt: null };
    const on = { signal: app.signal };
    const card = c.el;
    // off the card: it goes, unless the pointer is on the card's own block (a new card placed away from the pointer, say)
    card.addEventListener('pointerleave', () => (c.hideTimer = later(app, () => !(app.state.hover?.type === 'node' && app.state.hover.id === c.of) && hideCard(app, c), 200)), on);
    // the wheel over the card belongs to the map: hide the card and pass the event on
    card.addEventListener('wheel', (e) => {
        e.preventDefault();
        hideCard(app, c);
        app.scene.labels.domElement.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false, signal: app.signal });
    card.addEventListener('pointerenter', () => (cancel(app, c.hideTimer), cancel(app, c.aimTimer)), on); // it reached the card
    return c;
}

const cardBox = (c: Card): Box => {
    const r = c.el.getBoundingClientRect();
    return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
};
/**
 * The pointer left the card's block for `hit`: 'wait' while it heads for the card (inside the triangle, not yet on the
 * card) — the hover stays on the card's block; 'give' when it went elsewhere onto something — the card goes at once;
 * 'pass' otherwise (its block, the card itself, an empty spot off the way: the usual rules).
 */
function aimOf(c: Card, hit: Hit | null, at: ScreenPoint | undefined): 'wait' | 'give' | 'pass' {
    if (!c.of || c.el.hidden || c.el.pinned || !at || (hit?.type === 'node' && hit.id === c.of)) return 'pass';
    const box = cardBox(c);
    if (inBox(at, box) || c.el.matches(':hover')) return 'pass';
    if (c.onBlockAt && headingTo(at, c.onBlockAt, box)) return 'wait';
    return hit ? 'give' : 'pass';
}
/** The card's part of a hover: true while the pointer heads for the card (the hover waits). */
function cardWaits(app: App, c: Card, hit: Hit | null, at: ScreenPoint | undefined): boolean {
    at ??= app.scene.pointerAt ?? undefined; // the pointer left the map (for the card, say): where it is now
    cancel(app, c.aimTimer);
    if (hit?.type === 'node' && hit.id === c.of && at) c.onBlockAt = at;
    const aim = aimOf(c, hit, at);
    // resting inside the triangle short of the card: after a moment the card gives way to what is under the pointer
    if (aim === 'wait') c.aimTimer = later(app, () => !c.el.matches(':hover') && hideCard(app, c), AIM_GRACE_MS);
    if (aim === 'give') dropCard(app, c);
    return aim === 'wait';
}
const sameHit = (a: Hit | null, b: Hit | null): boolean => (a?.type ?? null) === (b?.type ?? null) && (a?.id ?? null) === (b?.id ?? null);
export function onHover(app: App, c: Card, hit: Hit | null, at?: ScreenPoint): void {
    const { state, scene } = app;
    if (hit?.type === 'envelope') hit = { type: 'edge', id: hit.edge! };
    if (cardWaits(app, c, hit, at)) return;
    // the same block whose card went (it moved off the pointer, say): the card comes back
    if (sameHit(hit, state.hover) && !(hit?.type === 'node' && c.el.hidden && !c.hoverTimer)) return;
    state.hover = hit;
    cancel(app, c.hoverTimer);
    if (hit?.type === 'node') {
        cancel(app, c.hideTimer);
        c.hoverTimer = later(app, () => {
            c.hoverTimer = 0;
            if (state.hover?.id !== hit.id) return;
            if (performance.now() - (scene.lastWheel?.t ?? 0) < 500) return; // not while zooming
            showCard(app, c, hit.id, at!);
            app.updateView();
        }, 150);
    } else {
        if (!c.el.pinned) c.hideTimer = later(app, () => !c.el.matches(':hover') && hideCard(app, c), 250); // a tapped card stays until the next tap
        app.updateView();
    }
}
export function showCard(app: App, c: Card, id: ElementId, at: ScreenPoint): void {
    const { model, state } = app;
    c.el.pinned = false;
    const n = model.nodes.get(id)!;
    const s = summary(model, id);
    c.of = id;
    c.onBlockAt = at;
    c.el.innerHTML = `<div class="c-kind">${esc(n.role)}${n.context ? ' · outside the slice' : ''}</div>
      <div class="c-title">${esc(n.title)}</div>
      ${cardStatsHtml(n, s)}
      ${isRail(n) ? railLines(s) : s.in.length ? `<div class="c-line">${s.in.slice(0, 3).map((g) => `${tag(g.channel)} ${esc(g.owner.title)}`).join(' ')}</div>` : ''}
      <div class="c-actions">
        ${n.children.length && state.focus !== id && !app.restSet().has(id) ? `<button class="btn small" data-focus="${esc(id)}">Enter ⤵</button>` : ''}
        ${n.methods?.length ? `<button class="btn small ghost" data-path="${esc(id)}|*">Path ▶</button>` : ''}
        <button class="btn small ghost" data-select="${esc(id)}">Details</button>
      </div>`;
    c.el.hidden = false;
    placeCard(app, c, id, at);
}
/** The four sides beside the block `b` (stage coordinates) the card could take, level with the pointer. */
function sidesOf(b: Box, at: ScreenPoint, r: DOMRect, w: number, h: number): Spot[] {
    const gap = 10;
    const clamp = (v: number, max: number) => Math.max(8, Math.min(v, max - 12));
    const bx0 = b.x0 - r.left, bx1 = b.x1 - r.left, by0 = b.y0 - r.top, by1 = b.y1 - r.top;
    const py = at.y - r.top - 16, px = at.x - r.left - 16;
    return [
        { fits: bx1 + gap + w + 12 <= r.width, x: bx1 + gap, y: clamp(py, r.height - h + 12) },
        { fits: bx0 - gap - w >= 8, x: bx0 - gap - w, y: clamp(py, r.height - h + 12) },
        { fits: by1 + gap + h + 12 <= r.height, x: clamp(px, r.width - w + 12), y: by1 + gap },
        { fits: by0 - gap - h >= 8, x: clamp(px, r.width - w + 12), y: by0 - gap - h },
    ];
}
/** The card beside its block (card-aim.ts): the side that fits and covers least of the other blocks. */
function placeCard(app: App, c: Card, id: ElementId, at: ScreenPoint): void {
    const { model, scene } = app;
    const card = c.el;
    const n = model.nodes.get(id)!;
    const r = app.$('#stage').getBoundingClientRect();
    delete card.dataset.sides;
    const w = card.offsetWidth, h = card.offsetHeight;
    const clamp = (v: number, max: number) => Math.max(8, Math.min(v, max - 12));
    // beside the block it describes (never over its middle, where the pointer rests): right, left, below or above —
    // of those that fit, the side that covers least of the other blocks, their middles most (card-aim.ts); level
    // with the pointer, so the way to the card's buttons is short
    // the block and its name: the card covers neither (hovered by its name, the card must not land under the pointer)
    const b = unionBox(scene.screenRect(id), scene.labelRect(id));
    let x = at.x - r.left + 16, y = at.y - r.top + 16;
    if (b) {
        const spots = sidesOf(b, at, r, w, h);
        // the other blocks: not this one, not the blocks it stands in
        const skip = new Set<ElementId>([id]);
        for (let p = n.parent; p; p = model.nodes.get(p)?.parent ?? null) skip.add(p);
        // the other blocks and the other names (a card over a neighbour's name hides it from the pointer)
        const blocks = [...scene.blockBoxes(skip), ...scene.nameBoxes(skip)].map((q) => ({ x0: q.x0 - r.left, y0: q.y0 - r.top, x1: q.x1 - r.left, y1: q.y1 - r.top }));
        const costs = spotCosts(spots, w, h, blocks);
        const i = chooseSpot(costs);
        card.dataset.sides = costs.map((cost, k) => `${SIDES[k]}:${cost === null ? '-' : +cost.toFixed(3)}`).join(' '); // what each side would cover (the browser checks read it)
        if (i >= 0) ({ x, y } = spots[i]);
        else { // the block fills the map: the card goes to the corner away from the pointer
            x = at.x - r.left < r.width / 2 ? r.width - w - 12 : 8;
            y = at.y - r.top < r.height / 2 ? r.height - h - 12 : 8;
        }
    }
    card.style.transform = `translate(${clamp(x, r.width - w + 12)}px, ${clamp(y, r.height - h + 12)}px)`;
}
const unionBox = (a: Box | null, b: Box | null): Box | null => (a && b ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : a ?? b);
/** A rail's card: who publishes to it and who it reaches, by name. */
function railLines(s: ReturnType<typeof summary>): string {
    const names = (list: { owner: { title: string } }[]) => {
        const all = [...new Set(list.map((g) => g.owner.title))];
        return all.length ? `${all.slice(0, 4).map(esc).join(', ')}${all.length > 4 ? ` and ${all.length - 4} more` : ''}` : '<span class="muted">none in the specs</span>';
    };
    return `<div class="c-line"><b>Publishers</b> ${names(s.in)}</div><div class="c-line"><b>Subscribers</b> ${names(s.out)}</div>`;
}
/** The card goes (the hover is not looked at again: the caller is the hover itself). */
function dropCard(app: App, c: Card): boolean {
    const shown = !c.el.hidden;
    c.el.hidden = true;
    c.el.pinned = false;
    c.of = c.onBlockAt = null;
    cancel(app, c.aimTimer);
    return shown;
}
/** Hidden, the card may uncover the place where the pointer rests: the hover looks there again. */
export function hideCard(app: App, c: Card): void {
    if (dropCard(app, c)) app.scene.rehover();
}
