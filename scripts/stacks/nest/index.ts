// The Nest stack's public entry point (`arch-map/stacks/nest`, package.json `exports`): what a project's generator
// calls. Everything else in scripts/stacks/nest/ is internal; check:arch keeps project code to this file.
export { scanBackend, loadTs } from './backend.ts';
export { scanFrontend, matchRoute } from './frontend.ts';
export { buildSpec, ident } from './to-spec.ts';
