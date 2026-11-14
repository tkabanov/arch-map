import type { NestConfig } from 'arch-map/types/stacks/nest';
import type { Satisfies } from 'arch-map/types/generator';

export const CONFIG_SOURCE = 'examples/library-nest/config.ts';
export const ID = 'library';
export const DOC = { id: 'library-nest', title: 'Public library — NestJS' };
export const CONTRACT_DOC = 'contracts/library.openapi.json';
export const BACKEND_SCOPE = ['books', 'members', 'loans', 'reservations', 'branches', 'notices', 'notifications'];
export const BACKEND = { id: 'api', title: 'Library API', technology: 'NestJS, Sequelize', description: 'Catalog, circulation and reminders.', dir: 'backend', repoUrl: 'examples/library-nest/target/backend' };
export const FRONTENDS = [{ id: 'web', title: 'Library catalog', technology: 'Vue, TypeScript', description: 'Browse and borrow books.', dir: 'web', roots: ['src'], repoUrl: 'examples/library-nest/target/web', area: (_rel: string) => 'src/catalog' }];
export const DATABASE = { id: 'library.db', title: 'Library database', technology: 'PostgreSQL', description: 'Catalog and circulation records.' };
export const EXTERNALS = { 'library.ext.catalog': { title: 'Catalog exchange', description: 'Shares public book metadata.', technology: 'HTTPS' }, 'library.ext.email': { title: 'Email provider', description: 'Delivers loan notices.', technology: 'SMTP' } };
export const EXTERNAL_CLIENTS = { CatalogGateway: { external: 'library.ext.catalog', kind: 'https', title: 'Catalog lookup', technology: 'HTTPS' }, EmailGateway: { external: 'library.ext.email', kind: 'smtp', title: 'Loan notices', technology: 'SMTP' } };
export const EVENT_DECORATORS = {};
export const INBOUND = [{ from: 'library.ext.catalog', controller: 'BookController', method: 'create', kind: 'webhook', title: 'New catalog entry', technology: 'HTTPS' }];
export const READ_METHODS = new Set(['findAll', 'findOne', 'findByPk', 'count']);
export const SLICE_PATHS = /^(books|loans|reservations)\b/;
export const DOMAIN_EVENTS = { bus: 'LibraryBus', decorator: 'OnDomainEvent', technology: 'In-process event bus' };
export type StackConfig = Satisfies<NestConfig, typeof import('./config.ts')>;
