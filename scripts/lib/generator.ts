// The generator helpers' public entry point (`arch-map/generator`, package.json `exports`): what a project's generator
// and snapshot scripts use around the stacks — write a spec document (validated, normalized), report its errors, find
// the project's spec folder.
export { writeSpec, serializeSpec, validate, formatError, SpecInvalidError, SCHEMA_REF } from './spec-io.ts';
export { specsDirOf } from './projects.ts';
