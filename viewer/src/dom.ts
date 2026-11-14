// Helpers every part of a map uses: its elements by selector (within its own shadow root), its saved preferences,
// timers that end with it, and the real target of an event that crossed the shadow boundary.

/** An element of the map's markup (markup.ts) by selector, within one map's root. */
export type Query = <E extends HTMLElement = HTMLElement>(s: string) => E;
// every selector names an element of the markup (`#legend details` may be absent: it is read with ?.)
export const queryIn = (root: ParentNode): Query => <E extends HTMLElement = HTMLElement>(s: string): E => root.querySelector<E>(s) as E;

/** A narrow map (its host's width, as style.css's `@container (max-width: 900px)`): the panel is under the map (and the step bar between them). */
export const NARROW_PX = 900;
export const isNarrow = (host: HTMLElement): boolean => host.clientWidth <= NARROW_PX;

/**
 * Shows `el` in the narrow layout. When the map scrolls inside its host (an element of a given height), only the map's
 * own scroller moves: `scrollIntoView` would scroll the page around it too. A map that grows with the page (the site)
 * has no scroller of its own: the page scrolls.
 */
export function revealInMap(scroller: HTMLElement, el: HTMLElement, smooth: boolean): void {
    const behavior = smooth ? 'smooth' : 'auto';
    if (scroller.scrollHeight <= scroller.clientHeight) return el.scrollIntoView({ behavior });
    scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top, behavior });
}

/** The map's host is the full-screen element of its root (the document, or the shadow root of a component around the map). */
export const isFullscreen = (host: HTMLElement): boolean => (host.getRootNode() as Document | ShadowRoot).fullscreenElement === host;

/** A map's saved preferences: `<storageKey>.<name>` in localStorage; `false` keeps nothing (defaults, never written). */
export interface Prefs {
    get(k: string, d: boolean): boolean;
    set(k: string, on: boolean): void;
}
export function prefsOf(storageKey: string | false): Prefs {
    return {
        get(k, d) {
            if (storageKey === false) return d;
            try {
                const v = localStorage.getItem(`${storageKey}.${k}`);
                return v === null ? d : v === '1';
            } catch {
                return d;
            }
        },
        set(k, on) {
            if (storageKey === false) return;
            try {
                localStorage.setItem(`${storageKey}.${k}`, on ? '1' : '0');
            } catch {
                /* a private window: the choice lasts for this page */
            }
        },
    };
}

/** What owns timers: the set of those pending, and `dead` once it is gone (a late timer then does nothing). */
export interface Timed {
    timers?: Set<number>;
    dead?: boolean;
}
/** `setTimeout` that belongs to `owner`: cleared when it is destroyed, a no-op if it fires after. */
export function later(owner: Timed, fn: () => unknown, ms: number): number {
    const id: number = setTimeout(() => {
        owner.timers?.delete(id);
        if (!owner.dead) fn();
    }, ms) as unknown as number;
    owner.timers?.add(id);
    return id;
}
/** `clearTimeout` of a timer set with `later`. */
export function cancel(owner: Timed, id: number): void {
    clearTimeout(id);
    owner.timers?.delete(id);
}
/** Ends every timer of `owner` and marks it gone. */
export function endTimers(owner: Timed): void {
    owner.dead = true;
    for (const id of owner.timers ?? []) clearTimeout(id);
    owner.timers?.clear();
}

/** The element an event started on, inside a shadow root too (a listener outside it sees the host as the target). */
export const targetOf = (e: Event): Element => (e.composedPath?.()[0] ?? e.target) as Element;

/** The focused element within the root `box` is in (a shadow root keeps its own). */
const activeIn = (box: Node): Element | null => (box.getRootNode() as unknown as DocumentOrShadowRoot).activeElement ?? null;

/**
 * Re-renders `box` without losing the keyboard's place: when focus was inside, it goes back to the same control (a
 * step of the list: the current step), else to a nearby one — never to <body>.
 */
export function keepFocus(box: HTMLElement, render: () => unknown): void {
    const a = activeIn(box);
    const key = a && a !== document.body && box.contains(a) ? focusKey(a as HTMLElement) : null;
    render();
    if (!key) return;
    const b = box.querySelector<HTMLElement>(`${key}:not(:disabled)`) ?? box.querySelector<HTMLElement>('[data-scstep]:not(:disabled), button:not(:disabled), summary');
    b?.focus();
}
function focusKey(el: HTMLElement): string | null {
    if (el.dataset.goto !== undefined) return '[data-goto][aria-current]';
    const [k, v] = Object.entries(el.dataset)[0] ?? [];
    return k ? `[data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${CSS.escape(v!)}"]` : null;
}

/**
 * Scrolls the panel's step list so the current step is in view (centred when it was out of sight). Only a panel that
 * scrolls itself is moved: on a narrow screen the panel is part of the page and keeps the reader's place.
 */
export function revealCurrentStep(panel: HTMLElement): void {
    const cur = panel.querySelector<HTMLElement>('.sc-steps [aria-current]');
    if (!cur || panel.scrollHeight <= panel.clientHeight) return;
    const box = panel.getBoundingClientRect(), r = cur.getBoundingClientRect();
    if (r.top >= box.top && r.bottom <= box.bottom) return;
    panel.scrollTop += r.top - box.top - (box.height - r.height) / 2;
}
