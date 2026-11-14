// A set of spec documents as the scripts check it (docs/architecture.md AD-1, AD-2, AD-7, AD-8):
// load → validate → merge → contracts and envelopes → scenarios. Every problem comes back positioned
// as { file, line, message, id? } (the `<file>:<line>: <message> (<id>)` convention).
// Used by check-specs and check-boundary; the rules themselves live in viewer/src/core/.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { loadSpec, validate, idLine, lineOf } from './spec-io.ts';
import { allDocumentPaths } from './projects.ts';
import { mergeSpecs } from '../../viewer/src/core/merge.ts';
import { resolveScenarios, resolvePointer, schemaProperties, splitKey } from '../../viewer/src/core/resolve.ts';
import type { ArchMapSpecDocument, Contract } from '../../types/spec.d.ts';
import type { MergedSet, ResolvedScenarios } from '../../types/core.ts';
import type { LoadedSpec, SpecError } from '../../types/generator.ts';

/** `checkSpecSet` result: `merged` and `scenarios` are null when a document does not load or validate. */
export interface CheckedSet {
    loaded: LoadedSpec[];
    merged: MergedSet | null;
    scenarios: ResolvedScenarios['scenarios'] | null;
    errors: SpecError[];
}

/** A contract document as `checkSpecSet` reads it (open JSON; OpenAPI when it has `paths`). */
interface ContractDoc {
    doc: { paths?: Record<string, Record<string, { operationId?: string } | null> | null> } | null;
    ops: Set<string>;
    isOpenApi: boolean;
}

/**
 * Expands arguments (index files — a JSON array of document names — and/or documents) into document paths in load
 * order. No arguments: the documents of every active project (env ARCH_MAP_PROJECTS), one set wider than any project.
 */
export function documentPaths(args: string[], errors: SpecError[]): string[] {
    if (!args.length) return allDocumentPaths();
    const paths: string[] = [];
    for (const arg of args) {
        const path = resolve(arg);
        if (basename(path) !== 'index.json') {
            paths.push(path);
            continue;
        }
        let list: unknown;
        try {
            list = JSON.parse(readFileSync(path, 'utf8'));
        } catch (err) {
            errors.push({ file: path, line: 1, message: `cannot read index: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` });
            continue;
        }
        if (!Array.isArray(list) || !list.every((n) => typeof n === 'string')) {
            errors.push({ file: path, line: 1, message: 'index must be a JSON array of document file names' });
            continue;
        }
        for (const n of list) paths.push(join(dirname(path), n));
    }
    return paths;
}

/** 1-based line of the first line at or after `from` containing `needle`; `from` when there is none. */
function lineAfter(text: string | null | undefined, needle: string, from: number): number {
    const lines = (text ?? '').split('\n');
    for (let i = Math.max(0, from - 1); i < lines.length; i++) if (lines[i].includes(needle)) return i + 1;
    return from;
}

/**
 * Loads and checks a set. `transform(doc)` (optional) rewrites each parsed document before validation
 * (check-boundary strips facets with it). Returns { loaded, merged, scenarios, errors }; `merged` and
 * `scenarios` are null when a document does not load or validate.
 */
export function checkSpecSet(paths: string[], { transform }: { transform?: (doc: ArchMapSpecDocument) => ArchMapSpecDocument } = {}): CheckedSet {
    const errors: SpecError[] = [];
    const loaded = paths.map(loadSpec);
    for (const spec of loaded) {
        errors.push(...spec.errors);
        if (spec.doc && transform) spec.doc = transform(spec.doc);
        if (spec.doc) errors.push(...validate(spec.doc, { file: spec.path, text: spec.text }));
    }
    if (errors.length) return { loaded, merged: null, scenarios: null, errors };

    const byName = new Map(loaded.map((s) => [s.name, s]));
    const at = (docName: string, line: number, message: string, id?: string): void => {
        const spec = byName.get(docName);
        errors.push({ file: spec?.path ?? docName, line, message, ...(id !== undefined ? { id } : {}) });
    };
    const textOf = (docName: string): string => byName.get(docName)?.text ?? '';

    // ---- merge: ids, scoping, claims, overrides (core/merge.js) ----
    // every document loaded and validated here (an error returned above)
    const merged = mergeSpecs(loaded.map((s) => ({ name: s.name, doc: s.doc! })), { strict: true });
    for (const p of merged.errors) at(p.doc, p.id ? idLine(textOf(p.doc), p.id, p.occurrence ?? 1) : 1, p.message, p.id);

    // ---- contracts (AD-7): every doc, pointer and operationId resolves; envelopes name real schemas ----
    const contractDocs = new Map<string, ContractDoc>();
    const loadContract = (fromDoc: string, rel: string): ContractDoc => {
        const path = join(dirname(byName.get(fromDoc)!.path), rel);
        if (!contractDocs.has(path)) {
            let doc: ContractDoc['doc'] = null;
            if (existsSync(path)) {
                try {
                    doc = JSON.parse(readFileSync(path, 'utf8'));
                } catch {
                    doc = null;
                }
            }
            const ops = new Set<string>();
            for (const item of Object.values(doc?.paths ?? {})) for (const op of Object.values(item ?? {})) if (op?.operationId) ops.add(op.operationId);
            contractDocs.set(path, { doc, ops, isOpenApi: !!doc?.paths });
        }
        return contractDocs.get(path)!;
    };
    const checkContract = (docName: string, contract: Contract, line: number, id: string): void => {
        const c = loadContract(docName, contract.doc);
        if (!c.doc) return at(docName, line, `contract document "${contract.doc}" does not exist or is not JSON`, id);
        if (contract.operationId && c.isOpenApi && !c.ops.has(contract.operationId))
            at(docName, line, `operationId "${contract.operationId}" is not in ${contract.doc}`, id);
        for (const side of ['request', 'response'] as const) {
            const ptr = contract[side];
            if (ptr && typeof resolvePointer(c.doc, ptr) !== 'object') at(docName, line, `${side} "${contract.doc}${ptr}" does not resolve to a schema`, id);
        }
    };
    for (const { name, doc: d } of loaded) {
        const doc = d!;
        const text = textOf(name);
        for (const item of [...doc.elements, ...doc.edges]) if (item.contract) checkContract(name, item.contract, idLine(text, item.id), item.id);
        for (const s of doc.scenarios ?? [])
            for (const step of s.steps) if ('contract' in step && step.contract) checkContract(name, step.contract, lineOf(text, JSON.stringify(step.caption)), s.id);
        for (const [key, env] of Object.entries(doc.envelopes ?? {}) as [string, { title?: unknown; fields?: Record<string, unknown> }][]) {
            const keyLine = lineOf(text, JSON.stringify(key));
            const { doc: rel, pointer } = splitKey(key);
            const c = loadContract(name, rel);
            const schema = c.doc ? resolvePointer(c.doc, pointer) : undefined;
            if (!c.doc || typeof schema !== 'object') {
                at(name, keyLine, 'envelope key does not resolve to a schema', key);
                continue;
            }
            if (typeof env.title !== 'string' || !env.title) at(name, keyLine, 'envelope needs a "title"', key);
            const props = schemaProperties(c.doc, schema);
            for (const field of Object.keys(env.fields ?? {}))
                if (!props.has(field)) at(name, lineAfter(text, JSON.stringify(field), keyLine), `envelope field "${field}" is not a property of the schema`, key);
        }
    }

    // ---- scenarios (AD-8): every step resolves, every edge step has a contract (core/resolve.js) ----
    const { scenarios, problems } = resolveScenarios(merged);
    for (const p of problems) at(p.doc, lineOf(textOf(p.doc), p.at), p.message, p.id);

    return { loaded, merged, scenarios, errors };
}
