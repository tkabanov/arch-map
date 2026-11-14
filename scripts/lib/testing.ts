// The checks' public entry point for project tests (`arch-map/testing`, package.json `exports`): load and check a set
// of spec documents the way `npm run check` does, and read the active projects (env ARCH_MAP_PROJECTS).
export { checkSpecSet, documentPaths } from './spec-set.ts';
export { loadProjects, allDocumentPaths, projectsDir, specsDirOf } from './projects.ts';
