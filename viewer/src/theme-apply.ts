// Puts the theme (theme.ts) on a map's host element: the DOM half, so theme.ts stays pure and testable in Node.
import { ink, type Theme } from './theme.ts';
import type { Kinds } from './model.ts';

/** The color of a «break» tag (a Path that stops), and of a relation kind the legend does not know. */
export const BREAK_COLOR = '#f87171';
export const OTHER_COLOR = '#8a96a6';

/** The host's style properties a theme sets (removed again when the map is destroyed). */
const themeProps = (kinds: Kinds): string[] => [
    '--bg', '--panel', '--panel-2', '--fg', '--muted', '--line', '--accent', '--accent-strong', '--step',
    '--font-ui', '--font-label', '--font-code', '--k-break', '--k-other', ...Object.keys(kinds).map((k) => `--k-${k}`), 'color-scheme', '--sb-h', '--top-h',
];

/**
 * Puts the theme on the map's host: `data-theme` (style.css keys the light look on `:host([data-theme="light"])`), the
 * CSS variables, the fonts, and the relation colors of `kinds` as `--k-<kind>` (the panel's tags read them; the
 * legend and the scene take the colors from `kinds` itself). Only the host is touched, never the page.
 */
export function applyTheme(host: HTMLElement, t: Theme, kinds: Kinds): void {
    host.dataset.theme = t.mode;
    const st = host.style;
    st.colorScheme = t.mode;
    const c = t.colors;
    const vars: Record<string, string> = {
        '--bg': c.bg, '--panel': c.panel, '--panel-2': c.panel2, '--fg': c.fg, '--muted': c.muted, '--line': c.line,
        '--accent': c.accent, '--accent-strong': c.accentStrong, '--step': c.step,
        '--k-break': ink(BREAK_COLOR, t.mode), '--k-other': ink(OTHER_COLOR, t.mode),
    };
    for (const [k, v] of Object.entries(kinds)) vars[`--k-${k}`] = v.color;
    for (const [k, v] of Object.entries(vars)) st.setProperty(k, v);
    const font = (name: string | undefined, rest: string) => (name ? `"${name.replace(/["\\;{}]/g, '')}", ${rest}` : '');
    const f = t.fonts;
    for (const k of ['--font-ui', '--font-label', '--font-code']) st.removeProperty(k);
    if (f.ui) st.setProperty('--font-ui', font(f.ui, 'system-ui, sans-serif'));
    if (f.label ?? f.ui) st.setProperty('--font-label', font(f.label ?? f.ui, 'system-ui, sans-serif'));
    if (f.code) st.setProperty('--font-code', font(f.code, 'ui-monospace, Menlo, monospace'));
}

/** Saves only the presentation state the map owns, preserving unrelated host changes on destroy. */
export function preserveTheme(host: HTMLElement, kinds: Kinds): () => void {
    const theme = host.getAttribute('data-theme');
    const styles = themeProps(kinds).map((key) => ({ key, value: host.style.getPropertyValue(key), priority: host.style.getPropertyPriority(key) }));
    const hadStyle = host.hasAttribute('style');
    return () => {
        if (theme === null) host.removeAttribute('data-theme');
        else host.setAttribute('data-theme', theme);
        for (const { key, value, priority } of styles) {
            if (value) host.style.setProperty(key, value, priority);
            else host.style.removeProperty(key);
        }
        if (!hadStyle && !host.getAttribute('style')) host.removeAttribute('style');
    };
}
