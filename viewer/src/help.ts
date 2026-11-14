// The «?» sheet: every control and shortcut of the map in one place. `?` (or the header's «?» button) opens and closes
// it from any state, the cinema included; Esc, a click outside it or its ✕ close it. Esc that closes the sheet does
// nothing else (it does not also step back out on the map). A native modal <dialog> (showModal): the page behind it is
// inert — no Tab, Enter or click reaches it — and Tab / Shift+Tab cycle inside the sheet.
import { targetOf } from './dom.ts';
import type { App } from './app.ts';

const ROWS: [string, [string, string][]][] = [
    ['Pointer', [
        ['Hover a block', 'its card: Enter ⤵, Path ▶, Details'],
        ['Click', 'its summary in the panel'],
        ['Double-click', 'go inside the block'],
        ['Wheel toward a block', 'zoom in, then go inside'],
        ['Wheel out', 'zoom out, then leave'],
        ['Drag', 'pan'],
        ['Shift + drag', 'rotate'],
    ]],
    ['Keyboard on the map', [
        ['← / →', 'select the previous / next block (rows top to bottom, left to right)'],
        ['↑ / ↓', 'select a block in the row above / below'],
        ['Home / End', 'select the first / last block'],
        ['Enter', 'go into the selected block; on a block with nothing inside, its details'],
        ['Esc', 'step back: a Path, the selection, the block you are in'],
        ['Shift + ← ↑ → ↓', 'pan'],
        ['+ / −', 'zoom in and out (goes inside and leaves, as the wheel)'],
        ['Tab', 'on to the panel; Esc there comes back to the map'],
    ]],
    ['Scenarios', [
        ['Space', 'play the open scenario as a cinema; pause and resume'],
        ['← / →', 'previous / next step (on the map too; ↑ ↓ still select)'],
        ['F', 'full screen while the cinema plays'],
        ['Esc', 'leave the cinema'],
    ]],
    ['Anywhere', [
        ['?', 'this sheet'],
        ['Back / Forward', 'between the places you went (the browser’s buttons)'],
    ]],
];

const html = () => `<div class="hs-box" role="document"><div class="hs-head"><h3 id="hs-title">Controls and shortcuts</h3>
    <button class="hs-close" data-hsclose="1" aria-label="Close (Esc)" title="Close (Esc)">✕</button></div>
    <div class="hs-cols">${ROWS.map(([title, rows]) => `<section><h4>${title}</h4><dl>${rows.map(([k, v]) => `<dt>${title === 'Pointer' ? `<b>${k}</b>` : k.split(' / ').map((x) => `<kbd>${x}</kbd>`).join(' / ')}</dt><dd>${v}</dd>`).join('')}</dl></section>`).join('')}</div></div>`;

/** Tab / Shift+Tab move between the sheet's own focusable elements, wrapping: the focus never leaves it. */
function trapTab(app: App, sheet: HTMLElement, e: KeyboardEvent): void {
    const all = [...sheet.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')];
    if (!all.length) return;
    e.preventDefault();
    const i = all.indexOf(app.root.activeElement as HTMLElement);
    all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
}

/** Wires the sheet and its button; returns whether it is open (the debug API reads it). */
export function setupHelp(app: App): { open: () => boolean; toggle: (on?: boolean) => void } {
    const sheet = app.$<HTMLDialogElement>('#helpsheet'), btn = app.$('#helpbtn');
    const opt = { signal: app.signal };
    let back: HTMLElement | null = null;
    const isOpen = () => sheet.open;
    const toggle = (on = !isOpen()) => {
        if (on === isOpen()) return;
        if (on) {
            back = (app.root.activeElement ?? document.activeElement) as HTMLElement | null;
            sheet.innerHTML = html();
            sheet.showModal();
            sheet.querySelector<HTMLElement>('.hs-close')?.focus();
        } else {
            sheet.close();
            back?.focus?.();
        }
        btn.setAttribute('aria-expanded', String(on));
    };
    btn.addEventListener('click', () => toggle(), opt);
    sheet.addEventListener('cancel', (e) => (e.preventDefault(), toggle(false)), opt); // the dialog's own Esc, should one get through
    // a click on the backdrop or on ✕ closes it
    sheet.addEventListener('click', (e) => {
        if (e.target === sheet || (e.target as Element).closest('[data-hsclose]')) toggle(false);
    }, opt);
    // capture: before the map's, the cinema's and the page's own keys (only the keys that are this map's: opts.keyboard)
    window.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (!isOpen() && !app.keyFor(e)) return;
        const typing = targetOf(e).closest?.('input, textarea, select');
        if (e.key === '?' && !typing) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return toggle();
        }
        if (!isOpen()) return;
        e.stopImmediatePropagation(); // open, the sheet has the keyboard: its button works, the map's keys wait
        if (e.key === 'Escape') {
            e.preventDefault(); // not the dialog's own cancel: toggle restores the focus
            toggle(false);
        }
        if (e.key === 'Tab') trapTab(app, sheet, e);
    }, { capture: true, signal: app.signal });
    return { open: isOpen, toggle };
}
