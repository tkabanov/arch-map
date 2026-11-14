// `<arch-map>`: the map as a custom element over `mount` (index.ts). `src` names the spec documents (comma-separated
// URLs), `theme` the look ('dark', 'light'); `.specs` takes documents as objects instead; `.handle` is the mounted
// map. Connected, it mounts; disconnected, it is destroyed. Importing this module defines the element (once).
import { mount, type ArchMapHandle, type MountOptions, type SpecInput } from './index.ts';

export type { ArchMapHandle, MountOptions, SpecInput } from './index.ts';

const urlsOf = (src: string | null): string[] => (src ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const themeAttr = (v: string | null): MountOptions['theme'] => (v === 'light' || v === 'dark' ? v : undefined);

/** Without a DOM (a server render imports this module) there is no HTMLElement: an empty base, never defined. */
const Base = (typeof HTMLElement === 'undefined' ? class {} : HTMLElement) as typeof HTMLElement;

export class ArchMapElement extends Base {
    static observedAttributes = ['src', 'theme'];
    declare handle: ArchMapHandle | null;
    declare given: SpecInput[] | null;
    /** Options for the mount beyond `src` and `theme` (callbacks, keyboard, storageKey…): read when the map is mounted. */
    declare options: Omit<MountOptions, 'specs' | 'specsUrl' | 'theme'>;
    /** connectedCallback ran: before it, attribute changes (an upgrade replays each) do not mount. */
    declare connectedOnce: boolean;
    constructor() {
        super();
        this.handle = null;
        this.connectedOnce = false;
        // the upgrade step: `specs` and `options` set on the element before this module defined it are kept
        const own = this as unknown as Record<string, unknown>;
        const early = Object.prototype.hasOwnProperty.call(this, 'specs') ? (own.specs as SpecInput[] | null) : null;
        delete own.specs;
        this.given = early ?? null;
        this.options ??= {};
    }
    /** The spec documents as objects (instead of `src`). */
    get specs(): SpecInput[] | null {
        return this.given;
    }
    /** Documents as objects; null goes back to `src` (or, with no `src`, removes the map). */
    set specs(v: SpecInput[] | null) {
        this.given = v;
        const src = this.getAttribute('src');
        if (!this.handle) {
            if (this.connectedOnce && this.isConnected) this.start();
        } else if (v) void this.handle.setSpecs(v).catch(() => {});
        else if (src) void this.handle.setSpecs({ specsUrl: urlsOf(src) }).catch(() => {});
        else this.disconnectedCallback();
    }
    connectedCallback(): void {
        this.connectedOnce = true;
        this.start();
    }
    disconnectedCallback(): void {
        this.handle?.destroy();
        this.handle = null;
    }
    attributeChangedCallback(name: string, old: string | null, value: string | null): void {
        if (old === value || !this.connectedOnce) return;
        if (!this.handle) return void (this.isConnected && this.start());
        if (name === 'theme') void this.handle.setTheme(themeAttr(value)).catch(() => {});
        else if (!this.given) void this.handle.setSpecs({ specsUrl: urlsOf(value) }).catch(() => {});
    }
    private start(): void {
        if (this.handle || (!this.given && !this.getAttribute('src'))) return;
        const theme = themeAttr(this.getAttribute('theme'));
        this.handle = mount(this, { ...this.options, theme, ...(this.given ? { specs: this.given } : { specsUrl: urlsOf(this.getAttribute('src')) }) });
        this.handle.ready.catch(() => {}); // the notice is in the element; `onError` (options) hears about it
    }
}

/** Defines `<arch-map>` (or `tag`) unless it is defined already. */
export function defineArchMap(tag = 'arch-map'): void {
    if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, tag === 'arch-map' ? ArchMapElement : class extends ArchMapElement {});
}
defineArchMap();

declare global {
    interface HTMLElementTagNameMap {
        'arch-map': ArchMapElement;
    }
}
