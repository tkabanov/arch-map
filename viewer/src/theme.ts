// The look of the map: dark (the default, a night-time map table) or light (a page of a light site, e.g. a map embedded
// in documentation). Chosen per project (`theme` in project.json → specs/projects.json) and per page (?theme=light|dark,
// ?accent=, ?accent2=, ?bg=, ?panel=, ?panel2=, ?fg=, ?muted=, ?line=, ?step= as hex without #; ?font=, ?mono= family
// names); the page wins. The dark look with no overrides is exactly the look the map always had.
// Pure: each map instance keeps its own theme (app.theme, scene.theme); theme-apply.ts puts it on the map's host element.
import type { ViewerTheme, ThemeColors } from '../../types/project.ts';

export type ThemeMode = 'dark' | 'light';
export interface Theme {
    mode: ThemeMode;
    colors: Required<ThemeColors>;
    fonts: { ui?: string; label?: string; code?: string };
}

/** The dark look: the values style.css has always used. */
const DARK: Required<ThemeColors> = {
    bg: '#070a12', panel: '#0c111c', panel2: '#121a28', fg: '#e6ecf7', muted: '#8592a8', line: '#1e2a3d',
    accent: '#8ab4ff', accentStrong: '#8ab4ff', step: '#fbbf77',
};
/** A neutral light look; a project gives its own brand colors over it. */
const LIGHT: Required<ThemeColors> = {
    bg: '#f4f5f7', panel: '#ffffff', panel2: '#f0f2f5', fg: '#151b2b', muted: '#5b6576', line: '#dfe3ea',
    accent: '#2f6fde', accentStrong: '#2459b8', step: '#b25f05',
};

/** The query parameters that set a color (hex, `#` optional: `?accent=F4263D`); `accent2` is `accentStrong`. */
export const URL_COLORS: Record<string, keyof ThemeColors> = {
    bg: 'bg', panel: 'panel', panel2: 'panel2', fg: 'fg', muted: 'muted', line: 'line', accent2: 'accentStrong', step: 'step',
};
/** Every query parameter of the look: what goes along when the page switches project. */
export const THEME_PARAMS = ['theme', 'accent', ...Object.keys(URL_COLORS), 'font', 'mono'];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** `#abc`, `abc`, `#aabbcc`, `aabbcc` → `#aabbcc`; anything else → null (a URL must not inject CSS). */
export function hex(c: string | null | undefined): string | null {
    const m = HEX.exec(String(c ?? '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
    return '#' + h.toLowerCase();
}

/** The theme of a page: the project's, then the query string over it. Unknown values are ignored. */
export function resolveTheme(project: ViewerTheme | undefined, search: string | URLSearchParams): Theme {
    const params = typeof search === 'string' ? new URLSearchParams(search) : search;
    const asked = params.get('theme');
    const base = project?.base === 'light' ? 'light' : 'dark';
    const mode: ThemeMode = asked === 'light' || asked === 'dark' ? asked : base;
    const colors = { ...(mode === 'light' ? LIGHT : DARK) };
    // the project's colors belong to the project's base: a page that switches the base gets that base's defaults
    if (mode === base) setColors(colors, Object.entries(project?.colors ?? {}) as [keyof ThemeColors, string][]);
    const accent = hex(params.get('accent'));
    if (accent) setColors(colors, [['accent', accent], ['accentStrong', mode === 'light' ? shade(accent, -0.08) : accent]]);
    setColors(colors, Object.entries(URL_COLORS).map(([p, k]) => [k, params.get(p)]));
    return { mode, colors, fonts: { ...project?.fonts, ...urlFonts(params) } };
}
function setColors(colors: Required<ThemeColors>, pairs: [keyof ThemeColors, string | null | undefined][]): void {
    for (const [k, v] of pairs) {
        const c = hex(v);
        if (c && k in colors) colors[k] = c;
    }
}
/** ?font=, ?mono=: a family name, nothing else. */
function urlFonts(params: URLSearchParams): Theme['fonts'] {
    const font = (p: string) => params.get(p)?.trim().replace(/[^\w .-]/g, '') || undefined;
    const out: Theme['fonts'] = {};
    if (font('font')) out.ui = font('font');
    if (font('mono')) out.code = font('mono');
    return out;
}

// ---------- colors ----------
function toHsl(c: string): [number, number, number] {
    const n = parseInt(hex(c)!.slice(1), 16);
    const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number): string {
    const f = (n: number) => {
        const k = (n + h * 12) % 12;
        const a = s * Math.min(l, 1 - l);
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return '#' + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** Lightness moved by `dl` (−1…1). */
export function shade(c: string, dl: number): string {
    const [h, s, l] = toHsl(c);
    return fromHsl(h, s, Math.max(0, Math.min(1, l + dl)));
}
/** `a` mixed toward `b` by t (0…1), in sRGB. */
export function mix(a: string, b: string, t: number): string {
    const p = (c: string) => { const n = parseInt(hex(c)!.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
    const x = p(a), y = p(b);
    return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
/**
 * A palette color as it should look on this theme's background. Dark: as it is. Light: the same hue, deep enough to
 * read on a light page (the dark look's colors are pastel lights; on white they would vanish).
 */
export function ink(c: string, mode: ThemeMode): string {
    if (mode === 'dark' || !hex(c)) return c;
    const [h, s0, l0] = toHsl(c);
    const s = s0 < 0.35 ? s0 : Math.min(0.85, Math.max(s0, 0.55)); // greys stay a slate; colors stay clear, not neon
    // the same hue, darker until it is a third as bright as white (≥ 3:1 against a light page: lines and names read)
    let l = Math.min(l0, 0.45);
    while (l > 0.1 && luminance(fromHsl(h, s, l)) > 0.2) l -= 0.02;
    return fromHsl(h, s, l);
}
/** WCAG relative luminance, 0…1. */
export function luminance(c: string): number {
    const n = parseInt(hex(c)!.slice(1), 16);
    const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

// ---------- what the scene draws with ----------
/** The scene colors of each theme object, made once per theme (every material asks); a theme is never mutated. */
const cached = new WeakMap<Theme, ReturnType<typeof makeSceneColors>>();
/** What the scene draws with, derived from the theme. */
export function sceneColors(t: Theme): ReturnType<typeof makeSceneColors> {
    let c = cached.get(t);
    if (!c) cached.set(t, (c = makeSceneColors(t)));
    return c;
}
export type SceneColors = ReturnType<typeof makeSceneColors>;
function makeSceneColors(t: Theme) {
    const { bg, fg, muted, accent, step } = t.colors;
    if (t.mode === 'dark') {
        return {
            backdrop: ['#16203a', '#0b101d', '#05070c'], fog: '#070a12', sky: '#dfe8ff', ground: '#1a1f26',
            glassBase: '#0b1220', glassMix: 0.22, tick: '#e8eefc', railLine: '#fff4e0', layerDots: '#5d7bb8', context: '#5b6678',
            select: '#7aa8ff', ramp: ['#25324a', '#2f5f9e', '#3f8fb0', '#d9a03b', '#e5534b'], lineFrom: null as string | null,
        };
    }
    return {
        backdrop: [mix(bg, '#ffffff', 0.6), bg, shade(bg, -0.035)], fog: bg, sky: '#ffffff', ground: shade(bg, -0.12),
        glassBase: '#ffffff', glassMix: 0.16, tick: fg, railLine: step, layerDots: mix(muted, bg, 0.35), context: mix(muted, bg, 0.3),
        select: accent, ramp: [mix(muted, bg, 0.55), '#2f5f9e', '#2a8aa6', '#c98a1b', '#d6402f'], lineFrom: bg as string | null,
    };
}
