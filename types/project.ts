// The project manifest (<projects dir>/<name>/project.json, schema specs/schema/project.schema.json; the projects dir is
// env ARCH_MAP_PROJECTS) as scripts/lib/projects.ts returns it, and what publish-specs gives the viewer
// (viewer/public/specs/projects.json).

/** A script a project runs: path relative to the project folder. */
export interface ProjectScript {
    script: string;
    /** default arguments, used when none are given on the command line */
    args?: string[];
    /** env variables that must be set (after defaults) */
    needs?: string[];
}

export interface ProjectEnvVar {
    about: string;
    /** used when the variable is not set; `${OTHER}` expands another variable */
    default?: string;
    /** a path that must exist under the directory the variable names */
    mustHave?: string;
}

/** Colors of the viewer's look, each `#rrggbb` (or `#rgb`); unset ones keep the base's. */
export interface ThemeColors {
    /** the page behind the map */
    bg?: string;
    /** the bars, the panel, the cards */
    panel?: string;
    /** a raised surface on a panel (menus, inputs, rows) */
    panel2?: string;
    /** text */
    fg?: string;
    /** secondary text */
    muted?: string;
    /** borders */
    line?: string;
    /** the selection, buttons, links, focus rings */
    accent?: string;
    /** the accent where it is a fill under text (buttons): a deeper variant */
    accentStrong?: string;
    /** scenario steps (the numbered path, the step bar, the cinema) */
    step?: string;
}

/** project.json `theme`: how the viewer looks for this project. The page's ?theme=, ?accent=, ?accent2=, ?bg=, ?step= override it. */
export interface ViewerTheme {
    /** dark (default) or light */
    base?: 'dark' | 'light';
    colors?: ThemeColors;
    /** font family names; a family the viewer does not bundle must be installed where the map is viewed */
    fonts?: { ui?: string; label?: string; code?: string };
}

export interface ProjectManifest {
    name: string;
    title: string;
    /** the viewer's look for this project (dark when unset) */
    theme?: ViewerTheme;
    /** the whole checked set, in load order (file names in the project's spec folder) */
    documents: string[];
    /** what the map opens with: a subset of `documents` */
    open: string[];
    idPrefixes: string[];
    env: Record<string, ProjectEnvVar>;
    generate: ProjectScript;
    snapshots?: Record<string, ProjectScript>;
    determinism: {
        roots: string[];
        withoutEnv?: string[];
        outputs: string[];
        withoutRunTime?: string[];
        guard?: string[];
    };
}

/** A loaded manifest with its folders resolved (absolute paths). */
export interface Project extends ProjectManifest {
    /** <projects dir>/<name>/ */
    dir: string;
    /** where its spec documents live: <projects dir>/<name>/specs/ */
    specsDir: string;
}

/** <projects dir>/index.json */
export interface ProjectIndex {
    /** required when `order` is not empty */
    default?: string;
    order: string[];
}

/** One project as the viewer gets it (viewer/public/specs/projects.json). */
export interface ViewerProject {
    name: string;
    title: string;
    theme?: ViewerTheme;
    documents: string[];
    open: string[];
}

/** viewer/public/specs/projects.json */
export interface ViewerManifest {
    /** null when no project is published */
    default: string | null;
    projects: ViewerProject[];
}
