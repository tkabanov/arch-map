// Loading (AD-12): the spec documents by URL, a full-screen notice in the map when something is wrong, and the
// contract documents, which load on first use. Which documents a page shows (projects.json, ?project=, ?docs=) is the
// site's (site.ts); the check every set passes is options.ts `checkSpecs`.
import { contractIndex } from './panel.ts';
import { esc } from './scene-util.ts';
import type { App } from './app.ts';
import type { ViewerProject } from '../../types/project.ts';

/**
 * A full-screen notice in the map instead of the map (never a blank screen). The controls that need a map (search,
 * Scenarios, View) are hidden; `projects` (the site) are offered as links, each title once.
 */
export function showNotice(root: ParentNode, title: string, lines: string[] = [], projects: ViewerProject[] = []): void {
    root.querySelectorAll<HTMLElement>('.searchbox, .viewwrap').forEach((el) => (el.hidden = true));
    const list = lines.length ? `<ul>${lines.slice(0, 20).map((l) => `<li><code>${esc(l)}</code></li>`).join('')}</ul>` : '';
    const links = projects.length ? `<p class="notice-h">Open a project</p><ul class="notice-links">${projects.map((p) => `<li><a href="?project=${encodeURIComponent(p.name)}">${esc(p.title)}</a></li>`).join('')}</ul>` : '';
    const stage = root.querySelector('#stage');
    if (stage) stage.innerHTML = `<div class="notice"><h3>${esc(title)}</h3>${list}${links}</div>`;
    console.warn(`${title}${lines.length ? `: ${lines.join('; ')}` : ''}`);
}
/** A JSON document by URL; every failure names the URL (a network error, an HTTP status, a body that is not JSON). */
export const getJson = async (url: string, signal?: AbortSignal): Promise<unknown> => {
    const named = (err: unknown) => new Error(`${url}: ${(err as Error)?.message ?? err}`);
    const r = await fetch(url, { signal }).catch((err) => { throw named(err); });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json().catch((err) => { throw named(err); });
};
/** The contract documents of a map: fetched from `base` (`specs/<project>/`, or the folder of the first spec URL). */
export const fetchContracts = (base: string) => (name: string): Promise<unknown> => getJson(`${base}${name}`);

/**
 * The contract documents (the backend's OpenAPI is over a megabyte) load on first use, not with the map: the first
 * time anything asks for one — a panel with endpoints, a scenario step's contract, an envelope, a schema opened —
 * all of them are loaded; until then `get` gives undefined and `pending(doc)` says they are on the way. When they
 * land, what was drawn without them is drawn again.
 */
export class LazyDocs extends Map<string, unknown> {
    declare names: Set<string>;
    declare onLoad: () => void;
    declare failed: Set<string>;
    declare loading: Promise<void> | null;
    declare loader: (name: string) => Promise<unknown>;
    /** `loader`: one contract document by the name the specs give it */
    constructor(names: Set<string>, onLoad: () => void, loader: (name: string) => Promise<unknown>) {
        super();
        this.loader = loader;
        this.names = names;
        this.onLoad = onLoad;
        this.failed = new Set();
        this.loading = null;
    }
    get(doc: string): unknown {
        const v = super.get(doc);
        if (v === undefined && this.names.has(doc)) this.load();
        return v;
    }
    pending(doc: string): boolean {
        return this.names.has(doc) && !super.has(doc) && !this.failed.has(doc);
    }
    load(): Promise<void> {
        return (this.loading ??= Promise.all(
            [...this.names].map((doc) =>
                Promise.resolve()
                    .then(() => this.loader(doc))
                    .then(
                        (json) => this.set(doc, json),
                        (err) => (this.failed.add(doc), console.warn(`contract ${doc} not loaded: ${err?.message ?? err}`)),
                    ),
            ),
        ).then(() => this.onLoad()));
    }
}
/** The contract documents came in: what was drawn without them is drawn again (not once the map is gone). */
export function contractsLoaded(app: App): void {
    const { state, api, envCtx, contractDocs } = app;
    if (app.dead) return;
    Object.assign(api, contractIndex(contractDocs));
    envCtx.cache.clear(); // envelopes built without their schema
    if (!state.placed) return;
    app.renderPanel();
    app.updateView();
    app.refreshCinemaContract();
}
