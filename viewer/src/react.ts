// `<ArchMap … />`: a thin React wrapper over `mount` (index.ts). It renders a <div> (className, style) with the map's
// own element inside — React never touches that one's classes, which the map uses (cinema, still) —, mounts once,
// passes later `specs` / `specsUrl` / `theme` to the map, and destroys it on unmount. React is an optional peer dependency.
import { createElement, useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import { mount, type ArchMapHandle, type MountOptions, type SpecInput } from './index.ts';

export type { ArchMapHandle, MountOptions, SpecInput } from './index.ts';

/**
 * Props: `specs` / `specsUrl` and `theme` follow later renders (by content: an equal inline array is no change);
 * `className`, `style` and the callbacks (`onSelect`, `onFocus`, `onError`, `onHandle`: the latest ones are called) too.
 * Every other option (`urlState`, `storageKey`, `keyboard`, `debug`, `loadContract`, `contractsBase`, `title`, `name`,
 * `nofacets`) is read once, when the map mounts.
 */
export interface ArchMapProps extends MountOptions {
    className?: string;
    style?: CSSProperties;
    /** the mounted map, once (and null after unmount) */
    onHandle?: (handle: ArchMapHandle | null) => void;
}

/** Compare complete JSON documents: schema versions describe the format, not content revisions. */
const specsKeyOf = (specs: SpecInput[] | undefined, specsUrl: string[] | undefined): string => JSON.stringify(specs ?? specsUrl ?? []);
const themeKeyOf = (theme: MountOptions['theme']): string => JSON.stringify(theme ?? null);

/** The content key of the specs, computed again only when the array given is another one (documents are megabytes). */
function useSpecsKey(specs: SpecInput[] | undefined, specsUrl: string[] | undefined): string {
    const last = useRef<{ given: unknown; key: string } | null>(null);
    const given = specs ?? specsUrl;
    if (!last.current || last.current.given !== given) last.current = { given, key: specsKeyOf(specs, specsUrl) };
    return last.current.key;
}

export function ArchMap(props: ArchMapProps): ReactElement {
    const { className, style, onHandle, ...options } = props;
    const el = useRef<HTMLDivElement>(null);
    const handle = useRef<ArchMapHandle | null>(null);
    const latest = useRef({ options, onHandle });
    latest.current = { options, onHandle };
    /** the specs and the theme the map has now (StrictMode replays effects: an equal key is never applied twice) */
    const applied = useRef<{ specs: string; theme: string } | null>(null);
    const { specs, specsUrl, theme } = options;
    const specsKey = useSpecsKey(specs, specsUrl), themeKey = themeKeyOf(theme);
    useEffect(() => {
        const o = latest.current.options;
        const h = mount(el.current!, {
            ...o,
            onSelect: (hit) => latest.current.options.onSelect?.(hit),
            onFocus: (id) => latest.current.options.onFocus?.(id),
            onError: (e) => latest.current.options.onError?.(e),
        });
        applied.current = { specs: specsKey, theme: themeKey };
        handle.current = h;
        latest.current.onHandle?.(h);
        return () => {
            h.destroy();
            handle.current = null;
            applied.current = null;
            latest.current.onHandle?.(null);
        };
    }, []);
    useEffect(() => {
        const h = handle.current, now = applied.current;
        if (!h || !now || now.specs === specsKey) return;
        now.specs = specsKey;
        void (specs ? h.setSpecs(specs) : h.setSpecs({ specsUrl: specsUrl ?? [] })).catch(() => {});
    }, [specsKey]);
    useEffect(() => {
        const h = handle.current, now = applied.current;
        if (!h || !now || now.theme === themeKey) return;
        now.theme = themeKey;
        void h.setTheme(theme).catch(() => {});
    }, [themeKey]);
    // the map's element has no props: React never rewrites its class or style, the map owns them
    return createElement('div', { className, style: { height: '100%', ...style } }, createElement('div', { ref: el }));
}
