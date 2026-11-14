// How the map draws the elements of this stack (docs/architecture.md AD-13): facet → glyph and role, emitted as the
// document's `glyphs`. Ordered: an element with several of these facets takes the first one (a Nest module that is
// also a database, say, does not happen today; the order is the one the viewer used before the list moved here).
import type { Glyph } from '../../../types/spec.d.ts';

export const NEST_GLYPHS: readonly Glyph[] = [
    { facet: 'nest.controller', shape: 'endpoints', role: 'controller' },
    { facet: 'nest.service', shape: 'core', role: 'service' },
    { facet: 'nest.repository', shape: 'stack', role: 'repository' },
    { facet: 'sequelize.model', shape: 'grid', role: 'table' },
    { facet: 'vue.view', shape: 'frame', role: 'Vue component' },
    { facet: 'ts.api-client', shape: 'arrow', role: 'API calls' },
    { facet: 'ts.module', shape: 'ring', role: 'front-end module' },
    { facet: 'mysql.database', shape: 'grid', role: 'database' },
    { facet: 'nest.module', shape: 'matrix', role: 'Nest module' },
];
