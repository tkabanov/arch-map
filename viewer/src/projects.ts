// Which project and which documents the page shows (pure: no DOM, no fetch; unit-tested in test/projects.test.ts).
// Input: viewer/public/specs/projects.json (scripts/publish-specs.ts) and the page's query string.
//   ?project=<name>        that project's `open` set; an unknown name is an error listing the projects
//   (none)                 the default project
//   ?docs=a.json,b.json    those documents (expert). With ?project they must be that project's; without it, names all in
//                          the default project stay there, otherwise the one project that has every name is taken
//                          (document names are unique across projects — check-specs keeps it so); names spread over
//                          projects or unknown are an error ("add ?project=").
import type { ViewerManifest, ViewerProject } from '../../types/project.ts';

export interface Picked {
    project: ViewerProject;
    /** document file names, in load order */
    documents: string[];
    /** where the project's documents and contracts are fetched from: `specs/<name>/` */
    base: string;
}
export interface PickError {
    error: string;
    lines: string[];
    /** the projects the page can open instead: the error page offers them as links */
    projects?: ViewerProject[];
}

/** The name the project switcher shows: the title before " — " (the long title with its description stays in the page title). */
export const shortTitle = (project: ViewerProject): string => project.title.split(' — ')[0].trim() || project.name;
/** The switcher's labels, in order: each short title, but a project whose short title another project shares keeps its full title (the name when the titles are equal too). */
export function shortTitles(projects: ViewerProject[]): string[] {
    const shorts = projects.map(shortTitle);
    return projects.map((p, i) => {
        if (shorts.filter((s) => s === shorts[i]).length < 2) return shorts[i];
        return projects.filter((q) => q.title === p.title).length > 1 ? `${p.title} (${p.name})` : p.title;
    });
}
const picked = (project: ViewerProject, documents: string[]): Picked => ({ project, documents, base: `specs/${project.name}/` });
/** The project the page opens without ?project=, or why there is none. */
function defaultOf(manifest: ViewerManifest): ViewerProject | PickError {
    if (!manifest.projects.length) return { error: 'No projects', lines: ['specs/projects.json lists no project: point ARCH_MAP_PROJECTS at a projects directory and publish again (npm run viewer)'] };
    const def = manifest.projects.find((p) => p.name === manifest.default);
    return def ?? { error: `The default project "${manifest.default}" is not in specs/projects.json`, lines: [], projects: manifest.projects };
}

export function pick(manifest: ViewerManifest, search: string | URLSearchParams): Picked | PickError {
    const params = typeof search === 'string' ? new URLSearchParams(search) : search;
    const name = params.get('project');
    const docs = params.get('docs')?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
    const byName = (n: string) => manifest.projects.find((p) => p.name === n);

    if (name !== null) {
        const project = byName(name);
        if (!project) return { error: `Unknown project "${name}"`, lines: [], projects: manifest.projects };
        if (!docs.length) return picked(project, project.open);
        const foreign = docs.filter((d) => !project.documents.includes(d));
        if (foreign.length) return { error: `?docs= names documents that are not in ${project.name}`, lines: [...foreign, `${project.name} has: ${project.documents.join(', ')}`], projects: manifest.projects };
        return picked(project, docs);
    }
    const def = defaultOf(manifest);
    if ('error' in def) return def;
    if (!docs.length) return picked(def, def.open);
    if (docs.every((d) => def.documents.includes(d))) return picked(def, docs);
    const owners = new Set(docs.map((d) => manifest.projects.find((p) => p.documents.includes(d))?.name ?? '?'));
    const [only] = owners;
    if (owners.size === 1 && only !== '?') return picked(byName(only)!, docs);
    const unknown = docs.filter((d) => !manifest.projects.some((p) => p.documents.includes(d)));
    return {
        error: unknown.length ? '?docs= names documents no project has' : '?docs= names documents of more than one project: add ?project=',
        lines: unknown.length ? unknown : docs.map((d) => `${d}: ${manifest.projects.find((p) => p.documents.includes(d))!.name}`),
        projects: manifest.projects,
    };
}
