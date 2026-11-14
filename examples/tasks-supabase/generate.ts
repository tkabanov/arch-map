import { loadParser, migrationIndex, readToml, snapshotIndex, buildSupabaseSpec, analyzeEdgeFunctions, buildEdgeSpec, supabaseIds, analyzeReactClient, buildReactClientSpec } from 'arch-map/stacks/supabase';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as config from './config.ts';
import { writeSpec } from 'arch-map/generator';
import { targetHash, writeReport } from './helpers.ts';
import type { DbSnapshot } from 'arch-map/types/stacks/supabase';

const home = fileURLToPath(new URL('.', import.meta.url));
const root = join(home, 'target');
const out = join(home, 'specs');
const commit = targetHash(root);
const text = readFileSync(join(root, 'demo-schema.json'), 'utf8');
const snap: DbSnapshot = JSON.parse(text);
const toml = readToml(join(root, 'supabase/config.toml'));
await loadParser();
const db = buildSupabaseSpec({ snap, config, index: migrationIndex(root, config.REPO.migrations), toml, commit, snapAt: snapshotIndex(text), snapFile: `${config.SOURCES}/demo-schema.json`, snapHash: commit });
const ids = supabaseIds(db.doc.elements, config);
const edge = buildEdgeSpec({ analysis: analyzeEdgeFunctions(ts, join(root, 'supabase/functions'), config.EDGE), openapi: JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')), config, ids, dbHttp: db.httpCalls, commit, fnConfig: () => ({ verify_jwt: true }), tomlAt: (section) => ({ repo: config.REPO.id, file: 'supabase/config.toml', line: toml.get(section)?.line ?? 1 }), domains: db.domains });
const web = buildReactClientSpec({ analysis: analyzeReactClient(ts, join(root, 'web'), config.REACT_CLIENT), config, ids, edgeDoc: edge.doc, supaDoc: db.doc, commit });
mkdirSync(join(out, 'contracts'), { recursive: true });
for (const [name, result] of [['tasks-database', db], ['tasks-edge', edge], ['tasks-web', web]] as const) {
    writeSpec(join(out, `${name}.json`), result.doc);
    writeReport(out, name, result);
}
writeFileSync(join(out, config.DOCS.edge.contract), `${JSON.stringify(edge.contracts, null, 2)}\n`);
