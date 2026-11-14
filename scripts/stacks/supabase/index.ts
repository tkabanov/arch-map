// The Supabase stack's public entry point (`arch-map/stacks/supabase`, package.json `exports`): what a project's
// generator, snapshot scripts and tests call. Everything else in scripts/stacks/supabase/ is internal; check:arch keeps
// project code to this file.
export { loadParser, analyzeFunction, analyzeSql } from './sql.ts';
export { migrationIndex, readToml, snapshotIndex } from './sources.ts';
export { buildSupabaseSpec } from './db.ts';
export { analyzeEdgeFunctions } from './edge.ts';
export { buildEdgeSpec } from './edge-spec.ts';
export { supabaseIds } from './ids.ts';
export { makeDomains } from './domains.ts';
export { analyzeReactClient } from './react-client.ts';
export { buildReactClientSpec } from './react-client-spec.ts';
export { takeDbSnapshot } from './snapshot.ts';
