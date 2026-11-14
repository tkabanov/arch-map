// The app's one context: what every part of the controller (map.ts, focus.ts, cinema.ts, …) works on. Parts do not
// import each other's functions; they call them through the context (`app.relayout()`), which map.ts fills in. One per
// map: two maps on a page share nothing — every piece of state a part keeps between calls lives here (`ui`).
import type { MapScene } from './scene.ts';
import type { CinemaSegment, ContractApi, EnvelopeContext, Model, PlacedNode, RoutedEdge, StepView, ViewPath, ViewScenario } from '../../types/viewer.ts';
import type { ElementId } from '../../types/spec.d.ts';
import type { Hit, SceneStats } from '../../types/scene.ts';
import type { Query, Prefs } from './dom.ts';
import type { Theme } from './theme.ts';
import type { Kinds } from './model.ts';
import type { LazyDocs } from './load.ts';
import type * as view from './view.ts';
import type * as bars from './bars.ts';
import type * as history from './history.ts';
import type * as play from './play.ts';
import type * as cinema from './cinema.ts';
import type * as focus from './focus.ts';

/** What is open, selected and playing — the one state the map is drawn from. */
export interface AppState {
    focus: ElementId | null;
    view: 'client' | 'tech';
    scenario: { id: string; i: number } | null;
    selected: Hit | null;
    path: ViewPath | null;
    hover: Hit | null;
    filters: Record<string, boolean>;
    gap: number;
    auto: boolean;
    pulses: boolean;
    tint: string;
    cooldown: number;
    folded: RoutedEdge[];
    // set by relayout (the first one runs at start-up, before anything reads them) and the preferences below
    expanded: Set<ElementId>;
    foldedById: Map<string, RoutedEdge>;
    placed: PlacedNode[];
    placedIds: Set<ElementId>;
    step: StepView | null;
    scCamera: boolean;
    scDeep: boolean;
    all?: boolean;
    focusArea?: number | null;
    baseAreas?: Map<ElementId, number> | null;
    /** Just went up to `id`: zoomOut's next look measures the parent's way out as if it had just been entered. */
    upRef?: { id: ElementId } | null;
    /** The camera distance at that first look (the overview comes only two notches past it). */
    upDist?: number | null;
    switching?: { id: ElementId; t0: number; last?: number } | null;
    /** Relations between the placed blocks that a legend filter keeps off the map (relayout; the status line). */
    hiddenByFilters?: number;
}
/** The parts of the state that start unset: relayout and the preferences below set them before anything reads them. */
export type SetLater = 'expanded' | 'foldedById' | 'placed' | 'placedIds' | 'step' | 'scCamera' | 'scDeep';

/** The cinema's state: playing, which part of the scenario it is in, its timers. */
export interface CineState {
    on: boolean;
    playing: boolean;
    phase: 'title' | 'step' | 'end';
    timers: number[];
    t0: number;
    ms: number;
    elapsed: number;
    idle: number;
    generation?: number;
    segments?: CinemaSegment[];
    segment?: number;
    layout?: string;
}

/** The functions of a part, as the context offers them: without the context argument (`app.updateView()`). */
type Bound<M> = {
    [K in keyof M as M[K] extends (app: App, ...a: never[]) => unknown ? K : never]: M[K] extends (app: App, ...a: infer A) => infer R ? (...a: A) => R : never;
};

/** How a map was mounted (index.ts resolves the options; options.ts has the defaults). */
export interface MapOpts {
    /** read and write the place on the map in the page's URL hash, go there on Back / Forward (the site) */
    urlState: boolean;
    /** 'page': the map takes every key on the page (the site); 'focus': only while its host has the focus or the pointer */
    keyboard: 'focus' | 'page';
    /** localStorage prefix of the map's preferences; false keeps none */
    storageKey: string | false;
}

/** What the parts of a map keep between calls (module state before maps could be mounted twice). */
export interface UiState {
    /** bars.ts: the watch on the step bar's and the header's heights */
    barWatch: ResizeObserver | null;
    hintTimer: number;
    toastTimer: number;
    /** bars.ts: the mouse hints in the status line, until the person first moves the map */
    statusHints: boolean;
    lastStats: SceneStats | null;
    /** the specs' unresolved calls: counted once (they do not change while the map is open) */
    unresolved: number | null;
    /** the status line's html last written (it runs on every drawn frame) */
    statusHtml?: string;
    /** history.ts: applying the URL — what it writes back replaces, never pushes */
    restoring: boolean;
    appliedHash: string | null;
    /** cinema.ts: the overlay with the letterbox and the subtitles, and the black cut between the map and the cinema */
    cineEl: HTMLDivElement | null;
    veilEl: HTMLDivElement | null;
}

/** The map's own pieces: where it lives, its lifetime, its options, look and preferences. */
export interface MapEnv {
    /** the page's element the map was mounted into, and the open shadow root it renders in */
    host: HTMLElement;
    root: ShadowRoot;
    /** an element of the map by selector, within its root */
    $: Query;
    /** aborted on destroy: every listener of the map is registered with it */
    signal: AbortSignal;
    opts: MapOpts;
    theme: Theme;
    /** KINDS in this map's theme colors */
    kinds: Kinds;
    prefs: Prefs;
    ui: UiState;
    /** timers of the map (dom.ts `later`): cleared on destroy; `dead` from then on */
    timers: Set<number>;
    dead?: boolean;
    /** whether a key event is for this map (opts.keyboard) */
    keyFor(e: KeyboardEvent): boolean;
}

/** What map.ts keeps and the parts call: the panel, the selection, the hover card. */
interface MainOps {
    renderPanel(): void;
    select(hit: Hit | null): void;
    hideCard(): void;
}

/** What the parts of the controller share. */
export interface App extends MainOps, MapEnv, Bound<typeof view>, Bound<typeof bars>, Bound<typeof history>, Bound<typeof play>, Bound<typeof cinema>, Bound<typeof focus> {
    model: Model;
    scene: MapScene;
    state: AppState;
    scenarios: ViewScenario[];
    cine: CineState;
    contractDocs: LazyDocs;
    api: ContractApi;
    envCtx: EnvelopeContext;
}

/** Puts the functions of the parts on the context: `app.name(…)` calls `name(app, …)` of the part that has it. */
export function bind(app: App, ...parts: object[]): void {
    const target = app as unknown as Record<string, unknown>;
    for (const part of parts) {
        for (const [name, fn] of Object.entries(part)) {
            if (typeof fn === 'function') target[name] = (...a: unknown[]) => (fn as (app: App, ...a: unknown[]) => unknown)(app, ...a);
        }
    }
}
