// The map from the keyboard (P1-2). With the map focused (`#stage .labels`, role=application): the arrow keys move the
// selection over the blocks drawn now, in reading order (roving.ts) — ← → previous / next, ↑ ↓ the row above / below,
// Home / End the first / last — with a ring on the block and the selection said in `#sr-status` («Backend, system,
// 12 parts, 83 endpoints, 2 of 3»); Shift + arrows pan, + − zoom (as the wheel: in and out of blocks). Enter goes into
// the selected block (as a double-click) or, on a block with nothing inside or the one you are in, brings its details
// in the panel into the keyboard focus. Tab goes on to the panel; Esc in the panel steps back (actions.ts, as anywhere)
// and gives the keyboard back to the map. While a scenario is open ← → step it (actions.ts); ↑ ↓ still move.
import { announce, selectionStatus } from './a11y.ts';
import { rove, placeOf, ROVE_KEYS, type RoveKey } from './roving.ts';
import type { App } from './app.ts';

const LABEL = 'Architecture map. Arrow keys select the blocks in reading order, Home and End the first and last; Enter goes into the selected block or opens its details; Escape goes back. Shift with the arrow keys pans, plus and minus zoom. Tab goes on to the panel. Question mark lists every key.';
const ZOOM: Record<string, number> = { '+': -100, '=': -100, '-': 100, _: 100 };
const PAN: Record<string, [number, number]> = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
/** What Tab may land on in the panel. */
const FOCUSABLE = 'button:not(:disabled), [href], summary, input, select, [tabindex]:not([tabindex="-1"])';

/** Wires the map's keys, its accessible name and the ring on the keyboard's selection. */
export function setupMapKeys(app: App): void {
    const map = app.scene.labels.domElement;
    map.tabIndex = 0;
    map.setAttribute('role', 'application');
    map.setAttribute('aria-roledescription', 'map');
    map.setAttribute('aria-label', LABEL);
    const ring = keyRing(app);
    const on = { signal: app.signal };
    app.signal.addEventListener('abort', () => ring.hide()); // its animation frame goes with the map
    map.addEventListener('keydown', (e) => onMapKey(app, e, ring), on);
    map.addEventListener('pointerdown', () => delete map.dataset.keys, on); // the pointer took over: no ring
    map.addEventListener('blur', () => ring.hide(), on);
    map.addEventListener('focus', () => map.dataset.keys !== undefined && ring.show(), on);
    // Esc in the panel: the step back happens on the window (actions.ts); the keyboard returns to the map first, so the
    // panel's re-render does not drop it on the page
    app.$('#panel').addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !(e.target as Element).closest('input, textarea, select')) map.focus();
    }, on);
}

function onMapKey(app: App, e: KeyboardEvent, ring: Ring): void {
    if (e.metaKey || e.ctrlKey || e.altKey || app.cine.on || viewKey(app, e)) return;
    if (ROVE_KEYS.has(e.key) && !e.shiftKey && !(app.state.scenario && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
        e.preventDefault();
        e.stopPropagation();
        return roveTo(app, e.key as RoveKey, ring);
    }
    if (e.key === 'Enter') return onEnter(app, e);
    if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        toPanel(app, false);
    }
}

/** + − zoom (as the wheel at the middle of the map), Shift + arrows pan; true when the key was one of them. */
function viewKey(app: App, e: KeyboardEvent): boolean {
    const map = app.scene.labels.domElement;
    if (ZOOM[e.key]) {
        e.preventDefault();
        const r = map.getBoundingClientRect();
        map.dispatchEvent(new WheelEvent('wheel', { deltaY: ZOOM[e.key], clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
        return true;
    }
    if (!PAN[e.key] || !e.shiftKey) return false;
    e.preventDefault();
    e.stopPropagation(); // not a scenario's step
    app.scene.controls.pan(...PAN[e.key]);
    app.scene.controls.update();
    return true;
}

/** An arrow key, Home or End: the next block takes the selection, the ring and the announcement. */
function roveTo(app: App, key: RoveKey, ring: Ring): void {
    const blocks = app.scene.blocksOnMap();
    const sel = app.state.selected;
    const id = rove(blocks, sel?.type === 'node' ? sel.id : null, key);
    if (!id) return announce(app, 'No blocks on the map here');
    app.hideCard();
    app.scene.labels.domElement.dataset.keys = '';
    app.select({ type: 'node', id });
    announce(app, `${selectionStatus(app, { type: 'node', id })}, ${placeOf(blocks, id)}`);
    ring.show();
}

/** Enter: into the selected block (as a double-click), or its details in the panel when there is nothing to go into. */
function onEnter(app: App, e: KeyboardEvent): void {
    const sel = app.state.selected;
    if (sel?.type !== 'node') return;
    e.preventDefault();
    const n = app.model.nodes.get(sel.id);
    if (n?.children.length && app.state.focus !== n.id && !app.restSet().has(n.id)) return app.setFocus(n.id, { enter: true });
    toPanel(app, true);
}

/**
 * The keyboard goes to the panel: to its heading (`heading`: the details just asked for are read from their title), or
 * to its first control as Tab would; the heading when it has none. The map is the last stop of the stage, so without
 * this Tab could fall to the page when the panel is being redrawn.
 */
function toPanel(app: App, heading: boolean): void {
    const panel = app.$('#panel');
    const first = heading ? null : [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => el.getClientRects().length);
    if (first) return first.focus();
    const h = panel.querySelector<HTMLElement>('h3, h2') ?? panel;
    h.tabIndex = -1;
    h.focus();
}

interface Ring {
    show(): void;
    hide(): void;
}

/** The ring around the block the keyboard selected: follows it on screen while the map has the keyboard. */
function keyRing(app: App): Ring {
    const el = document.createElement('div');
    el.id = 'kbring';
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    app.$('#stage').append(el);
    let raf = 0;
    const map = app.scene.labels.domElement;
    const frame = () => {
        raf = 0;
        const sel = app.state.selected;
        const v = sel?.type === 'node' ? app.scene.nodes.get(sel.id) : undefined;
        const b = v && !v.ghost && !v.node._plate && v.obj.visible ? app.scene.screenRect(v.node.id) : null;
        if (!b || map.dataset.keys === undefined || app.root.activeElement !== map) return void (el.hidden = true);
        const r = app.$('#stage').getBoundingClientRect(), pad = 4;
        el.hidden = false;
        el.style.transform = `translate(${b.x0 - r.left - pad}px, ${b.y0 - r.top - pad}px)`;
        el.style.width = `${b.x1 - b.x0 + 2 * pad}px`;
        el.style.height = `${b.y1 - b.y0 + 2 * pad}px`;
        raf = requestAnimationFrame(frame);
    };
    return {
        show: () => void (raf || (raf = requestAnimationFrame(frame))),
        hide: () => {
            cancelAnimationFrame(raf);
            raf = 0;
            el.hidden = true;
        },
    };
}
