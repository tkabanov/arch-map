// The pure core's public entry point (`arch-map/core`, package.json `exports`): merge, tiers, Path, queries, scenario
// resolution — the answers the map and the checks give, for project tests over their own specs.
export { mergeSpecs } from './merge.ts';
export { trace, traceEndpoint, MAX_STEPS } from './path.ts';
export { readers, writers, callers, ownerOf, summary } from './queries.ts';
export { tierOf, isRail, DEFAULT_TIERS } from './tier.ts';
export { resolveScenarios, effectiveAccess, effectiveContract } from './resolve.ts';
