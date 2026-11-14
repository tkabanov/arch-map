// The search box as an ARIA combobox with a listbox of results: typing lists the matches (or says there are none and
// what can be searched); ArrowDown / ArrowUp move through them, Enter opens the active one (the first when none is
// active), Esc closes the list (a second Esc leaves the box). An endpoint opens its path, anything else is shown in
// its place.
import { search } from './model.ts';
import { esc } from './scene-util.ts';
import type { App } from './app.ts';
import type { SearchHit } from '../../types/viewer.ts';

export function setupSearch(app: App): void {
    const q = app.$<HTMLInputElement>('#q'), results = app.$('#results');
    const on = { signal: app.signal };
    let hits: SearchHit[] = [];
    let active = -1;
    const option = (i: number) => app.root.getElementById(`res-${i}`);
    const setOpen = (open: boolean) => {
        results.hidden = !open;
        q.setAttribute('aria-expanded', String(open));
        if (!open) setActive(-1);
    };
    function setActive(i: number): void {
        option(active)?.setAttribute('aria-selected', 'false');
        active = i;
        const el = option(i);
        el?.setAttribute('aria-selected', 'true');
        el?.scrollIntoView({ block: 'nearest' });
        if (el) q.setAttribute('aria-activedescendant', el.id);
        else q.removeAttribute('aria-activedescendant');
    }
    function go(h: SearchHit): void {
        setOpen(false);
        q.blur();
        if (h.endpoint?.handler) return app.startPath(h.node.id, h.endpoint.handler);
        app.goTo(h.node.id);
    }
    function render(): void {
        const text = q.value.trim();
        hits = search(app.model, q.value);
        setActive(-1); // the options are rebuilt below: nothing is active in the new list
        // under two characters nothing is searched yet: no list, no «no matches»
        if (text.length < 2) return setOpen(false), void (results.innerHTML = '');
        results.innerHTML = hits.length
            ? hits.map((h, i) => `<li role="option" id="res-${i}" aria-selected="false" data-i="${i}"><b>${esc(h.node.title)}</b><span>${esc(h.endpoint ? `${h.endpoint.method} ${h.endpoint.path} · path` : h.node.role)}</span></li>`).join('')
            : `<li class="res-empty" role="option" aria-disabled="true"><b>No matches for “${esc(text)}”</b><span>Search finds component and module titles, endpoint routes and table names.</span></li>`;
        setOpen(true);
    }
    q.addEventListener('input', render, on);
    q.addEventListener('focus', () => q.value.trim().length >= 2 && results.hidden && render(), on);
    q.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (results.hidden) render();
            if (!hits.length) return;
            e.preventDefault();
            const n = hits.length;
            const down = e.key === 'ArrowDown';
            return setActive(active < 0 ? (down ? 0 : n - 1) : (active + (down ? 1 : n - 1)) % n);
        }
        if (e.key === 'Enter' && hits.length && !results.hidden) {
            e.preventDefault();
            const hit = hits[Math.max(active, 0)];
            return hit && go(hit);
        }
        if (e.key === 'Escape') {
            if (results.hidden) return q.blur();
            e.stopPropagation();
            setOpen(false);
        }
    }, on);
    q.addEventListener('blur', () => setOpen(false), on);
    // a pointer press on the list must not take the focus from the box (the blur would close the list before the click)
    results.addEventListener('mousedown', (e) => e.preventDefault(), on);
    results.addEventListener('click', (e) => {
        const o = (e.target as Element).closest<HTMLElement>('[data-i]');
        if (o) go(hits[Number(o.dataset.i)]);
    }, on);
}
