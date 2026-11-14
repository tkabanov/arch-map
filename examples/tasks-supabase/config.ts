import type { SupabaseConfig } from 'arch-map/types/stacks/supabase';
import type { Satisfies } from 'arch-map/types/generator';

export const CONFIG_SOURCE = 'examples/tasks-supabase/config.ts';
export const NAME = 'Team tasks';
export const ID = 'tasks';
export const SOURCES = 'examples/tasks-supabase/target';
export const SNAPSHOT_ENV = 'demo';
export const SNAPSHOT_SCHEMAS = ['public'];
export const SHOWN_SCHEMAS = ['public'];
export const API_SCHEMAS = ['public'];
export const REPO = { id: 'taskcode', url: 'examples/tasks-supabase/target', migrations: 'supabase/migrations' };
export const DOCS = { supabase: { id: 'tasks-database', title: 'Task database and platform' }, edge: { id: 'tasks-edge', title: 'Task Edge Functions', contract: 'contracts/tasks-edge.openapi.json' }, reactClient: { id: 'tasks-web', title: 'Task board client' } };
export const DOMAINS = { synonyms: { tasks: 'task', teams: 'task', team: 'task', profiles: 'task', boards: 'task', comments: 'task', labels: 'task' }, extraWords: ['task', 'team'], notDomains: [], minTables: 1, minGroup: 1, minEdgeGroup: 1, splitAbove: 50 };
export const EDGE = { EXCLUDE_DIRS: ['openapi'], PORTS_DIR: 'helpers/ports', KICK_HELPERS: {}, SPLIT_SHARED: [], SHARED: ['helpers'], AUTH: { options: 'authenticate', guards: {}, portGuards: {} } };
export const EXTERNALS = { email: { id: 'tasks.ext.email', name: 'Email provider', technology: 'HTTPS', hosts: [/^mail\.example\.test$/] } };
export const INBOUND = [];
export const SUPABASE_ARCH = 'https://github.com/supabase/supabase';
export const TIERS: SupabaseConfig['TIERS'] = [{ id: 'ui', title: 'Interface' }, { id: 'service', title: 'Services' }, { id: 'data', title: 'Data' }];
const service = (key: string, name: string, technology: string, toml?: string, path?: string) => ({ id: `tasks.platform.${key}`, name, technology, description: name, ...(toml ? { toml } : {}), ...(path ? { path } : {}) });
export const SUPABASE_SERVICES = {
    gateway: service('gateway', 'API gateway', 'Kong'), rest: service('rest', 'Data API', 'PostgREST', 'api', '/rest/v1'),
    graphql: service('graphql', 'GraphQL', 'pg_graphql'), auth: service('auth', 'Authentication', 'GoTrue', 'auth', '/auth/v1'),
    storage: service('storage', 'File storage', 'Supabase Storage', 'storage', '/storage/v1'), realtime: service('realtime', 'Live changes', 'Realtime', 'realtime', '/realtime/v1'),
    meta: service('meta', 'Database metadata', 'postgres-meta'), studio: service('studio', 'Studio', 'Supabase Studio'), pooler: service('pooler', 'Connection pool', 'Supavisor'),
};
export const REACT_CLIENT: SupabaseConfig['REACT_CLIENT'] = {
    repo: { id: 'taskweb', url: 'examples/tasks-supabase/target/web' }, APP: { name: 'Task board', technology: 'React, supabase-js', description: 'View tasks, attach files and request summaries.' },
    SRC: 'src', TSCONFIG: 'tsconfig.json', ROUTES: 'app/routes.tsx', ROUTES_EXPORT: 'routes', RESOURCES: 'api/resources', SEAM: 'api/live', OWNERS_FILE: 'api/ownership.ts',
    MOCK: /\/mock\//, PORT_TYPES: /Port$/, APP_ROOTS: /App\.tsx$/, APP_SKIP: /\/skip\//, EDGE_HELPERS: {}, STUB: { error: 'Error', message: /^Not implemented$/ }, EXTERNALS: {},
};
export type StackConfig = Satisfies<SupabaseConfig, typeof import('./config.ts')>;
