// A map's host element: its open shadow root with the map's styles and markup, the theme on the host, and the
// clean-up that leaves the host as the page gave it. Shared by `mount` (index.ts) and the site (site.ts, which shows its
// own notices before a map is mounted).
import css from './style.css?inline';
import { MARKUP } from './markup.ts';
import { applyTheme, preserveTheme } from './theme-apply.ts';
import { kindsFor, type Kinds } from './model.ts';
import type { Theme } from './theme.ts';

/**
 * The map's stylesheet, parsed once per document and shared by every map in it. A constructed stylesheet, not a
 * `<style>`: a Content-Security-Policy without `style-src 'unsafe-inline'` blocks the element, not the CSSOM.
 */
const sheets = new WeakMap<Document, CSSStyleSheet>();
function sheetOf(doc: Document): CSSStyleSheet | null {
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (!Sheet || !('adoptedStyleSheets' in ShadowRoot.prototype) || !('replaceSync' in Sheet.prototype)) return null;
    let sheet = sheets.get(doc);
    if (!sheet) sheets.set(doc, (sheet = new Sheet()));
    if (!sheet.cssRules.length) sheet.replaceSync(css);
    return sheet;
}

/** The host's shadow root, emptied and filled with the map's stylesheet and markup; the theme on the host. */
export function prepareHost(host: HTMLElement, theme: Theme): { root: ShadowRoot; kinds: Kinds } {
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const sheet = sheetOf(host.ownerDocument);
    const tpl = document.createElement('template');
    tpl.innerHTML = MARKUP;
    if (sheet) {
        root.adoptedStyleSheets = [sheet];
        root.replaceChildren(tpl.content);
    } else {
        const style = document.createElement('style'); // a browser without constructed stylesheets
        style.textContent = css;
        root.replaceChildren(style, tpl.content);
    }
    const kinds = kindsFor(theme.mode);
    applyTheme(host, theme, kinds);
    return { root, kinds };
}

/** Saves host presentation once per mount, before any rebuild can overwrite it. */
export function preserveHost(host: HTMLElement): () => void {
    const restoreTheme = preserveTheme(host, kindsFor('dark'));
    const classes = ['cinema', 'still'].map((name) => ({ name, had: host.classList.contains(name) }));
    const hadClass = host.hasAttribute('class');
    return () => {
        restoreTheme();
        for (const { name, had } of classes) host.classList.toggle(name, had);
        if (!hadClass && !host.classList.length) host.removeAttribute('class');
    };
}

/** Empties the shadow root and restores the host's original presentation. */
export function clearHost(host: HTMLElement, restore: () => void): void {
    host.shadowRoot?.replaceChildren();
    if (host.shadowRoot && 'adoptedStyleSheets' in host.shadowRoot) host.shadowRoot.adoptedStyleSheets = [];
    restore();
}

/**
 * Resolves once the host has a size (a hidden or not yet laid out container: the map is drawn when it gets one), or
 * when `signal` aborts (the mount was destroyed or replaced meanwhile: the caller checks the signal).
 */
export function whenSized(host: HTMLElement, signal: AbortSignal, warnAfter = 1000): Promise<void> {
    const sized = () => host.clientWidth > 0 && host.clientHeight > 0;
    if (sized()) return Promise.resolve();
    return new Promise((resolve) => {
        // a host that is shown (it has client rects) yet has no size after a second is a layout problem, not a hidden tab
        const warn = setTimeout(() => {
            if (sized() || !host.getClientRects().length) return;
            console.warn(`@arch-map/viewer: the map waits for its element to get a size (now ${host.clientWidth} × ${host.clientHeight} px). Give the element a width and a height (in a flex row or a float its width may collapse to 0).`, host);
        }, warnAfter);
        const done = () => (clearTimeout(warn), watch.disconnect(), resolve());
        const watch = new ResizeObserver(() => sized() && done());
        watch.observe(host);
        signal.addEventListener('abort', done);
    });
}

/**
 * The markup gives an element its custom properties in `data-style` (`<i data-style="--c:#7aa8ff">`), never in a
 * `style` attribute, which a Content-Security-Policy without `style-src 'unsafe-inline'` blocks; the CSSOM it allows.
 * They are applied as elements arrive in the map's root (before the next paint), until `signal` aborts.
 */
export function applyDataStyles(root: ShadowRoot, signal: AbortSignal): void {
    const set = (el: HTMLElement) => {
        el.style.cssText = el.dataset.style ?? '';
        el.removeAttribute('data-style');
    };
    const scan = (node: Node) => {
        if (node.nodeType !== 1) return;
        const el = node as HTMLElement;
        if (el.dataset?.style !== undefined) set(el);
        el.querySelectorAll<HTMLElement>('[data-style]').forEach(set);
    };
    const watch = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach(scan)));
    watch.observe(root, { childList: true, subtree: true });
    root.querySelectorAll<HTMLElement>('[data-style]').forEach(set);
    signal.addEventListener('abort', () => watch.disconnect(), { once: true });
}
