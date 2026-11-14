// Spec documents on disk (docs/architecture.md AD-1, AD-2, AD-10): load, validate, write.
// The only place that validates against specs/schema/spec.schema.json and the only writer of spec JSON.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ArchMapSpecDocument } from '../../types/spec.d.ts';
import type { LoadedSpec, SpecError } from '../../types/generator.ts';

/** A document `validate` has not checked yet: any field may be missing or of another type. */
interface UncheckedDoc {
    elements?: unknown;
    edges?: unknown;
    repos?: unknown;
}
interface UncheckedSource {
    repo?: unknown;
    file?: unknown;
    line?: unknown;
    config?: unknown;
}
interface UncheckedItem {
    id?: unknown;
    from?: unknown;
    to?: unknown;
    fromMethod?: unknown;
    toMethod?: unknown;
    channel?: unknown;
    provenance?: unknown;
    source?: UncheckedSource | null;
    sites?: unknown;
}

const archDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SPECS_DIR = join(archDir, 'specs');
export const SCHEMA_PATH = join(SPECS_DIR, 'schema', 'spec.schema.json');

let compiled: ValidateFunction | null = null;
function schemaValidator(): ValidateFunction {
    if (!compiled) {
        const ajv = new Ajv2020({ allErrors: true });
        compiled = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
    }
    return compiled;
}

/** 1-based line of the n-th line containing `needle`, or 0 when there is none. */
function findLine(text: string | null | undefined, needle: string, occurrence = 1): number {
    const lines = (text ?? '').split('\n');
    let seen = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(needle) && ++seen === occurrence) return i + 1;
    }
    return 0;
}

/** Like findLine, but 1 when not found (messages always carry a line). */
export const lineOf = (text: string | null | undefined, needle: string, occurrence = 1): number => findLine(text, needle, occurrence) || 1;

/**
 * Line of an id in a hand JSON file (convention: first line containing `"<id>"`), preferring the line of
 * its `"id": "<id>"` field so a reference to the id earlier in the file does not win.
 */
export const idLine = (text: string | null | undefined, id: string, occurrence = 1): number =>
    findLine(text, `"id": ${JSON.stringify(id)}`, occurrence) || lineOf(text, JSON.stringify(id), occurrence);

/** Path shown in messages: relative to the working directory when inside it. */
export const displayPath = (path: string): string => {
    const rel = relative(process.cwd(), path);
    return rel && !rel.startsWith('..') ? rel : path;
};

/** `<file>:<line>: <message> (<id>)` — the scripts' error convention. */
export const formatError = (e: SpecError): string => `${displayPath(e.file)}:${e.line}: ${e.message}${e.id ? ` (${e.id})` : ''}`;

/**
 * Reads and parses one spec document. Returns { path, name, text, doc, errors }; on a JSON syntax error
 * `doc` is null and `errors` holds one positioned error.
 */
export function loadSpec(path: string): LoadedSpec {
    const name = path.split(/[\\/]/).pop()!;
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (err) {
        return { path, name, text: '', doc: null, errors: [{ file: path, line: 1, message: `cannot read file: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` }] };
    }
    try {
        return { path, name, text, doc: JSON.parse(text) as ArchMapSpecDocument, errors: [] };
    } catch (e) {
        const err = e as Error;
        const pos = Number(/position (\d+)/.exec(err.message)?.[1]);
        const line = Number.isFinite(pos) ? text.slice(0, pos).split('\n').length : Number(/line (\d+)/.exec(err.message)?.[1]) || 1;
        return { path, name, text, doc: null, errors: [{ file: path, line, message: `invalid JSON: ${err.message}` }] };
    }
}

/** Expected edge id from its fields (AD-6). */
export const edgeIdOf = (e: { from?: unknown; fromMethod?: unknown; to?: unknown; toMethod?: unknown; channel?: unknown }): string =>
    `${e.from}${e.fromMethod ? `#${e.fromMethod}` : ''}>${e.to}${e.toMethod ? `#${e.toMethod}` : ''}:${e.channel}`;

/** The array item (element, edge, scenario) an instance path points into, and its id. */
function itemAt(doc: unknown, instancePath: string): string | null {
    const m = /^\/(elements|edges|scenarios)\/(\d+)/.exec(instancePath);
    if (!m) return null;
    const item = (doc as Record<string, UncheckedItem[] | undefined> | null | undefined)?.[m[1]]?.[Number(m[2])];
    return typeof item?.id === 'string' ? item.id : null;
}

function describe(err: ErrorObject): string {
    const where = err.instancePath || '/';
    switch (err.keyword) {
        case 'additionalProperties':
            return `${where}: unknown field "${err.params.additionalProperty}"`;
        case 'enum':
            return `${where}: must be one of ${err.params.allowedValues.join(', ')}`;
        case 'const':
            return `${where}: must be ${JSON.stringify(err.params.allowedValue)}`;
        case 'required':
            return `${where}: missing field "${err.params.missingProperty}"`;
        default:
            return `${where}: ${err.message}`;
    }
}

/**
 * Validates a parsed document against the schema plus the id rules JSON Schema cannot state
 * (edge id = from/to/methods/channel). Returns positioned errors: [{ file, line, message, id? }].
 * `text` (the file's source) is used for line numbers; without it every line is 1.
 */
export function validate(input: unknown, { file = '<memory>', text = '' }: { file?: string; text?: string } = {}): SpecError[] {
    const doc = input as UncheckedDoc | null | undefined;
    const errors: SpecError[] = [];
    const check = schemaValidator();
    if (!check(doc)) {
        const seen = new Set<string>();
        for (const err of check.errors!) {
            if (err.keyword === 'if') continue; // the failing "then"/"else" branch is reported on its own
            const id = itemAt(doc, err.instancePath);
            const message = describe(err);
            const key = `${id}|${message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // Position: the item's id line (as written, also when the id itself is malformed),
            // else the line of the top-level key.
            const top = err.instancePath.split('/')[1];
            const line = id ? idLine(text, id) : top ? lineOf(text, `"${top}"`) : 1;
            errors.push({ file, line, message, ...(id ? { id } : {}) });
        }
    }
    for (const e of Array.isArray(doc?.edges) ? (doc.edges as (UncheckedItem | null)[]) : []) {
        if (!e || typeof e.id !== 'string' || typeof e.from !== 'string' || typeof e.to !== 'string') continue;
        const want = edgeIdOf(e);
        if (e.id !== want) errors.push({ file, line: idLine(text, e.id), message: `edge id must be "${want}"`, id: e.id });
    }
    // Provenance (AD-5): extracted → code source in a repo of this document; declared → config source.
    const repos = doc?.repos && typeof doc.repos === 'object' ? doc.repos : {};
    for (const [kind, list] of [['element', doc?.elements], ['edge', doc?.edges]] as const) {
        for (const item of Array.isArray(list) ? (list as (UncheckedItem | null)[]) : []) {
            if (!item || typeof item.id !== 'string') continue;
            const src = item.source;
            const at = { file, line: idLine(text, item.id), id: item.id };
            if (item.provenance === 'extracted') {
                if (!src || typeof src.repo !== 'string' || typeof src.file !== 'string' || !Number.isInteger(src.line))
                    errors.push({ ...at, message: `extracted ${kind} needs a code source { repo, file, line }` });
                else if (!Object.hasOwn(repos, src.repo)) errors.push({ ...at, message: `source repo "${src.repo}" is not in "repos"` });
            }
            if (item.provenance === 'declared' && typeof src?.config !== 'string') errors.push({ ...at, message: `declared ${kind} needs a config source` });
            for (const s of Array.isArray(item.sites) ? (item.sites as (UncheckedSource | null)[]) : [])
                if (s && typeof s.repo === 'string' && !Object.hasOwn(repos, s.repo)) errors.push({ ...at, message: `site repo "${s.repo}" is not in "repos"` });
        }
    }
    return errors;
}

// Code-unit order, not locale order: output must not depend on the machine's locale.
const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
const byKey = (k: string) => (a: Record<string, unknown>, b: Record<string, unknown>) => cmp(a[k] as string, b[k] as string);
const bySite = (a: { repo: string; file: string; line: number }, b: { repo: string; file: string; line: number }) => cmp(a.repo, b.repo) || cmp(a.file, b.file) || a.line - b.line;

/** Deterministic form (AD-10): sorted elements/edges/methods/ops/sites, recursively sorted keys. */
export function normalize(doc: object): unknown {
    // the arrays are sorted as they come: a spec document, or what a test hands in
    const out = { ...doc } as { elements?: Record<string, unknown>[]; edges?: Record<string, unknown>[] };
    if (Array.isArray(out.elements)) {
        out.elements = out.elements
            .map((el) => (Array.isArray(el.methods) ? { ...el, methods: [...el.methods].sort(byKey('name')) } : el))
            .sort(byKey('id'));
    }
    if (Array.isArray(out.edges)) {
        out.edges = out.edges
            .map((e) => {
                const n = { ...e };
                if (Array.isArray(n.ops)) n.ops = [...new Set(n.ops)].sort();
                if (Array.isArray(n.sites)) n.sites = [...n.sites].sort(bySite);
                return n;
            })
            .sort(byKey('id'));
    }
    return sortKeys(out);
}

function sortKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(v).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
        return o;
    }
    return v;
}

/** Serialized form of a spec document: normalized, 2-space indent, trailing newline, no timestamps. */
export const serializeSpec = (doc: object): string => `${JSON.stringify(normalize(doc), null, 2)}\n`;

export class SpecInvalidError extends Error {
    declare errors: SpecError[];
    constructor(errors: SpecError[]) {
        super(`spec is invalid (${errors.length} error${errors.length === 1 ? '' : 's'})`);
        this.errors = errors;
    }
}

/**
 * `$schema` of every spec document: the schema as seen from a document of the published tree, where publish-specs puts
 * each project's documents in `<name>/` next to `schema/` (viewer/public/specs/). It does not depend on where the
 * project's sources live (in this repo or in a projects directory elsewhere), so moving a project changes no byte of
 * its specs.
 */
export const SCHEMA_REF = '../schema/spec.schema.json';

/**
 * Validates in memory and writes the normalized document, with `$schema` = SCHEMA_REF. Throws SpecInvalidError (nothing written) when
 * invalid, so a generator never leaves an invalid spec on disk (AD-2).
 */
export function writeSpec(path: string, doc: object): string {
    const text = serializeSpec({ ...doc, $schema: SCHEMA_REF });
    const errors = validate(JSON.parse(text), { file: path, text });
    if (errors.length) throw new SpecInvalidError(errors);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return text;
}
