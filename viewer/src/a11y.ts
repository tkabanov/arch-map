// What a screen reader is told: one polite status line (`#sr-status`, visually hidden) that says the selection and the
// scenario step — nothing else on the page is a live region — and the aria-expanded state of the toolbar's menus.
import { KINDS } from './model.ts';
import { blockFigures } from './figures.ts';
import { countEndpoints } from './panel.ts';
import type { App } from './app.ts';
import type { Hit } from '../../types/scene.ts';

/** Says `text` once in the map's status line: the same text again is not repeated (a re-render of the step bar must not read the step twice). */
export function announce(app: Pick<App, 'root'>, text: string): void {
    const el = app.root?.getElementById('sr-status'); // none outside a page (the unit tests drive focus.ts in Node with a stub app)
    if (el && el.textContent !== text) el.textContent = text;
}

/**
 * «Backend, system, 12 parts, 83 endpoints» / «REST relation: A → B»: the selection's title, kind and own figures (the
 * panel's role line, figures.ts), short on purpose (the panel has the rest).
 */
export function selectionStatus(app: App, hit: Hit | null): string {
    if (!hit) return 'Nothing selected';
    const title = (id: string) => app.model.nodes.get(id)?.title ?? id;
    if (hit.type === 'node') {
        const n = app.model.nodes.get(hit.id);
        return n ? [n.title, n.role || n.type, ...blockFigures(n, countEndpoints(n)).map((f) => `${f.n} ${f.unit}`)].join(', ') : '';
    }
    if (hit.type === 'edge') {
        const e = app.state.foldedById.get(hit.id);
        return e ? `${KINDS[e.group]?.title ?? 'Relation'} relation: ${title(e.from)} → ${title(e.to)}` : '';
    }
    return hit.type === 'envelope' ? `Envelope ${hit.id}` : '';
}

/**
 * Keeps `aria-expanded` of a menu button equal to whether its menu is shown. Menus are opened and closed from several
 * places (the button, Esc, a pick, the cinema), so the attribute follows the menu's `hidden` rather than each caller.
 */
export function syncExpanded(button: HTMLElement, menu: HTMLElement, signal: AbortSignal): void {
    button.setAttribute('aria-controls', menu.id);
    const sync = () => button.setAttribute('aria-expanded', String(!menu.hidden));
    const watch = new MutationObserver(sync);
    watch.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    signal.addEventListener('abort', () => watch.disconnect());
    sync();
}
