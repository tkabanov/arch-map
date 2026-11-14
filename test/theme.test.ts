// The viewer's look (viewer/src/theme.ts): dark by default with the values style.css always had; light from the project
// or ?theme=; colors from project.json and the query string, the page winning; nothing but hex reaches the CSS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, hex, ink, luminance, sceneColors } from '../viewer/src/theme.ts';

test('dark by default, with the colors the map always had', () => {
    const t = resolveTheme(undefined, '');
    assert.equal(t.mode, 'dark');
    assert.equal(t.colors.bg, '#070a12');
    assert.equal(t.colors.accent, '#8ab4ff');
    assert.equal(ink('#7cc4ff', 'dark'), '#7cc4ff');
    assert.equal(sceneColors(t).glassBase, '#0b1220');
    assert.equal(sceneColors(t).lineFrom, null);
});

test('light from the project, its colors and fonts; ?theme= and the color parameters win', () => {
    const project = { base: 'light' as const, colors: { bg: '#F5F3F3', fg: '#10123B', accent: '#F4263D', accentStrong: '#DC2237' }, fonts: { ui: 'Manrope', code: 'JetBrains Mono' } };
    const t = resolveTheme(project, '');
    assert.equal(t.mode, 'light');
    assert.deepEqual([t.colors.bg, t.colors.fg, t.colors.accent, t.colors.accentStrong], ['#f5f3f3', '#10123b', '#f4263d', '#dc2237']);
    assert.equal(t.colors.panel, '#ffffff'); // unset: the light base's
    assert.equal(t.fonts.ui, 'Manrope');
    const page = resolveTheme(project, '?accent=0a7&line=E2E3E7&font=Inter');
    assert.equal(page.colors.accent, '#00aa77');
    assert.equal(page.colors.line, '#e2e3e7');
    assert.equal(page.fonts.ui, 'Inter');
    // switching the base drops the project's colors (they were chosen for the other base)
    const dark = resolveTheme(project, 'theme=dark');
    assert.equal(dark.mode, 'dark');
    assert.equal(dark.colors.bg, '#070a12');
});

test('the query string alone gives a light page; only hex colors and plain family names pass', () => {
    const t = resolveTheme(undefined, 'theme=light&accent=F4263D&bg=red;}&font=Man"rope;}');
    assert.equal(t.mode, 'light');
    assert.equal(t.colors.accent, '#f4263d');
    assert.notEqual(t.colors.accentStrong, '#f4263d'); // a deeper variant for fills under text
    assert.equal(t.colors.bg, '#f4f5f7');
    assert.equal(t.fonts.ui, 'Manrope');
    assert.equal(resolveTheme(undefined, 'theme=sepia').mode, 'dark');
    assert.equal(hex('url(x)'), null);
});

test('light: pastel palette colors are deepened to read on paper', () => {
    for (const c of ['#7cc4ff', '#fcd34d', '#34d399', '#fbbf77', '#9fb0c8']) {
        const d = ink(c, 'light');
        const contrast = (luminance('#f5f3f3') + 0.05) / (luminance(d) + 0.05);
        assert.ok(contrast >= 3, `${c} → ${d}: ${contrast.toFixed(2)}:1 against a light page`);
    }
});
