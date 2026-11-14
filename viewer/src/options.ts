// The pure half of mounting a map (index.ts `mount`): the options and their defaults, the spec documents as they were
// given (objects or `{ name, doc }`), the check every set of documents passes before a map is drawn (schema major,
// `mergeSpecs`, the contract documents they name), and the theme an option names. No DOM, no fetch: test/mount.test.ts.
import { mergeSpecs } from './core/merge.ts';
import { SCHEMA_MAJOR } from './spec-adapter.ts';
import { resolveTheme, type Theme } from './theme.ts';
import type { ArchMapSpecDocument, Contract, ElementId } from '../../types/spec.d.ts';
import type { MergedSet, SpecEntry } from '../../types/core.ts';
import type { ViewerTheme } from '../../types/project.ts';

/** A spec document as `mount` takes it: the document itself, or with the file name other documents `require` it by. */
export type SpecInput = ArchMapSpecDocument | { name: string; doc: ArchMapSpecDocument };

/** What `mount(el, options)` takes. Every field is optional; give `specs` or `specsUrl`. */
export interface MountOptions {
    /** the spec documents, as objects (a document, or `{ name, doc }` with the name the others `require` it by) */
    specs?: SpecInput[];
    /** the spec documents' URLs (relative to the page); fetched in this order */
    specsUrl?: string[];
    /** loads a contract document by name (the name the specs give in `contract.doc`); default: fetch from `contractsBase` */
    loadContract?: (name: string) => Promise<unknown>;
    /** the folder contract names are relative to; default: the folder of the first `specsUrl`, else the page's */
    contractsBase?: string;
    /** the look: 'dark' (default), 'light', or a project theme (`base`, `colors`, `fonts`) */
    theme?: ViewerTheme | 'dark' | 'light';
    /** read and write the place on the map in the page's URL hash, Back / Forward go between places (default false) */
    urlState?: boolean;
    /** localStorage prefix of the map's preferences (default 'archMap'); false keeps none */
    storageKey?: string | false;
    /** 'focus' (default): the map's keys work while it has the focus or the pointer; 'page': every key on the page */
    keyboard?: 'focus' | 'page';
    /** the debug API on the handle's `probe` (default false; the site has it on as `window.archMap`) */
    debug?: boolean;
    /** the title of the overview panel (default: the first document's title) */
    title?: string;
    /** a name for this map: the debug API's `project` (default: the first document's id) */
    name?: string;
    /** the spec documents without their facets (the site's ?nofacets=1) */
    nofacets?: boolean;
    /** the selection changed: a block, a relation, an envelope, or null */
    onSelect?: (hit: { type: string; id: string } | null) => void;
    /** the focus (the block the map is inside) changed; null is the overview */
    onFocus?: (id: ElementId | null) => void;
    /** the specs could not be loaded or do not agree: the map shows a notice instead */
    onError?: (error: MapError) => void;
}

/**
 * Why a map could not be drawn: a title and the lines under it (as the notice in the map shows them), and its kind:
 * `load` — a spec document could not be fetched or read; `specs` — the documents do not validate or agree; `map` — the
 * map could not be shown (no element to mount in, no WebGL…).
 */
export interface MapError extends Error {
    title: string;
    lines: string[];
    kind: MapErrorKind;
}
export type MapErrorKind = 'load' | 'specs' | 'map';
export function mapError(title: string, lines: string[] = [], kind: MapErrorKind = 'map'): MapError {
    return Object.assign(new Error(lines.length ? `${title}: ${lines.join('; ')}` : title), { lines, title, kind });
}

/** The options with their defaults filled in. */
export interface ResolvedOptions {
    urlState: boolean;
    storageKey: string | false;
    keyboard: 'focus' | 'page';
    debug: boolean;
    nofacets: boolean;
}
export function resolveOptions(o: MountOptions = {}): ResolvedOptions {
    return {
        urlState: o.urlState === true,
        storageKey: o.storageKey === false ? false : typeof o.storageKey === 'string' && o.storageKey ? o.storageKey : 'archMap',
        keyboard: o.keyboard === 'page' ? 'page' : 'focus',
        debug: o.debug === true,
        nofacets: o.nofacets === true,
    };
}

/** The theme an option names: 'dark' / 'light', or a project theme over its base; unknown values give the dark look. */
export function themeOf(option: MountOptions['theme']): Theme {
    if (option === 'dark' || option === 'light') return resolveTheme(undefined, `theme=${option}`);
    return resolveTheme(option && typeof option === 'object' ? option : undefined, '');
}

/** The documents as entries with names: `{ name, doc }` as given, a bare document by its id (`<id>.json`). */
export function specEntries(specs: SpecInput[]): SpecEntry[] {
    return specs.map((s) => ('doc' in s && 'name' in s && typeof s.name === 'string' ? { name: s.name, doc: s.doc } : { name: `${(s as ArchMapSpecDocument).id ?? 'spec'}.json`, doc: s as ArchMapSpecDocument }));
}

/** The file name of a spec URL (what other documents `require` it by). */
export const nameOfUrl = (url: string): string => url.split(/[?#]/)[0].split('/').pop() || url;
/** The folder of a URL, with its trailing slash ('' for a bare file name). */
export const folderOf = (url: string): string => url.split(/[?#]/)[0].replace(/[^/]*$/, '');

/** Why a document cannot be drawn by this viewer (not one, or another schema major), or null. */
function versionProblem(doc: unknown): string | null {
    if (!doc || typeof doc !== 'object') return 'Not a spec document';
    const v = String((doc as { schemaVersion?: unknown }).schemaVersion ?? '?');
    return v.split('.')[0] === SCHEMA_MAJOR ? null : `Incompatible spec version: ${v} (expected ${SCHEMA_MAJOR}.x)`;
}

export type SpecCheck =
    | { ok: true; merged: MergedSet; contractNames: Set<string>; warnings: string[] }
    | { ok: false; title: string; lines: string[] };

/**
 * The check every set of documents passes before it is drawn: a document at all, the schema major the viewer reads,
 * then the merge (errors fail, warnings are returned); and the contract documents they name (AD-7: elements, edges,
 * scenario steps, envelopes), which load on first use.
 */
export function checkSpecs(entries: SpecEntry[]): SpecCheck {
    if (!entries.length) return { ok: false, title: 'No spec documents', lines: ['give `specs` or `specsUrl`'] };
    for (const { name, doc } of entries) {
        const bad = versionProblem(doc);
        if (bad) return { ok: false, title: bad, lines: [name] };
    }
    const merged = mergeSpecs(entries, { strict: false });
    const where = (p: { doc: string; message: string; id?: string }) => `${p.doc}: ${p.message}${p.id ? ` (${p.id})` : ''}`;
    if (merged.errors.length) return { ok: false, title: 'The specs do not agree', lines: merged.errors.map(where) };
    return { ok: true, merged, contractNames: contractNamesOf(merged), warnings: merged.warnings.map(where) };
}

/** The contract documents a merged set names: elements, edges, scenario steps, envelopes (which need their schemas). */
function contractNamesOf(merged: MergedSet): Set<string> {
    const names = new Set<string>();
    for (const x of [...merged.elements, ...merged.edges]) if (x.contract?.doc) names.add(x.contract.doc);
    for (const sc of merged.scenarios ?? []) for (const st of (sc.steps ?? []) as { contract?: Contract }[]) if (st.contract?.doc) names.add(st.contract.doc);
    for (const key of Object.keys(merged.envelopes ?? {})) names.add(key.split('#')[0]);
    return names;
}
