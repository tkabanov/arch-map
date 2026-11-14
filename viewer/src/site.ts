// The standalone site (`npm run viewer`): the first consumer of `mount`. It picks the project and its documents from
// specs/projects.json and the query string (projects.ts: ?project=, ?docs=), the look (?theme=, colors, fonts:
// theme.ts), then mounts the map with the site's options — the place in the URL hash, every key on the page, the
// debug API as `window.archMap` — and offers the other projects in the header's switcher.
import { mount, type ArchMapHandle } from './index.ts';
import { prepareHost } from './host.ts';
import { showNotice, getJson } from './load.ts';
import { pick, shortTitles } from './projects.ts';
import { resolveTheme, THEME_PARAMS, type Theme } from './theme.ts';
import type { MapError } from './options.ts';
import type { ViewerManifest, ViewerProject } from '../../types/project.ts';

declare global {
    interface Window {
        /** Debug API for the browser console and tests (the map's `probe`). */
        archMap: unknown;
    }
}

/** The page around the map takes its background, so nothing flashes in another color around it. */
function paintPage(t: Theme): void {
    document.documentElement.style.colorScheme = t.mode;
    document.body.style.background = t.colors.bg;
}

/** The projects of the site, or a notice in the map with why there are none. */
async function manifestOf(root: ShadowRoot): Promise<ViewerManifest | null> {
    try {
        const manifest = (await getJson('specs/projects.json')) as ViewerManifest;
        if (Array.isArray(manifest?.projects)) return manifest;
        showNotice(root, 'specs/projects.json must hold { default, projects: [...] }');
    } catch (err) {
        showNotice(root, 'Could not load the project list', [String((err as Error).message ?? err)]);
    }
    return null;
}

/** The header's project switcher: the page's look goes with it to the other project (theme.ts THEME_PARAMS). */
function projectSwitcher(root: ShadowRoot, projects: ViewerProject[], current: string, params: URLSearchParams): void {
    const select = root.querySelector<HTMLSelectElement>('#project');
    if (!select) return;
    const labels = shortTitles(projects);
    select.replaceChildren(...projects.map((project, i) => new Option(labels[i], project.name)));
    select.value = current;
    select.hidden = projects.length < 2;
    select.addEventListener('change', () => {
        const next = new URLSearchParams({ project: select.value });
        for (const k of THEME_PARAMS) if (params.has(k)) next.set(k, params.get(k)!);
        location.assign('?' + next);
    });
}

/** Starts the site in `el`; resolves with the mounted map (null when the page shows a notice instead). */
export async function startSite(el: HTMLElement): Promise<ArchMapHandle | null> {
    const params = new URLSearchParams(location.search);
    const early = resolveTheme(undefined, params); // ?theme= at once (no dark flash under a light page); the project's once it is known
    paintPage(early);
    const { root } = prepareHost(el, early);
    const manifest = await manifestOf(root);
    if (!manifest) return null;
    const chosen = pick(manifest, params);
    if ('error' in chosen) return showNotice(root, chosen.error, chosen.lines, chosen.projects), null;
    const { project, documents, base } = chosen;
    const theme = resolveTheme(project.theme, params);
    paintPage(theme);
    document.title = `${project.title} — Arch Map`;
    const handle = mount(el, {
        specsUrl: documents.map((name) => `${base}${name}`),
        contractsBase: base,
        theme: { base: theme.mode, colors: theme.colors, fonts: theme.fonts },
        urlState: true,
        keyboard: 'page',
        debug: true,
        title: project.title,
        name: project.name,
        nofacets: params.get('nofacets') === '1',
        // a document that would not load: the other projects are offered instead
        onError: (e: MapError) => e.kind === 'load' && showNotice(el.shadowRoot!, e.title, e.lines, manifest.projects),
    });
    try {
        await handle.ready;
    } catch {
        return null; // the notice is in the map
    }
    projectSwitcher(el.shadowRoot!, manifest.projects, project.name, params);
    window.archMap = handle.probe;
    return handle;
}
