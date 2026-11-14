// Envelopes (AD-7, AD-8): what object travels on a relation. A relation's effective contract names a
// request and/or a response schema; the client layer's `envelopes` give that object a human name and human field
// names. Without one, the envelope is the contract's own: schema name and property names. Request and response are two
// envelopes. Pure: no DOM, no three.js — main.js decides where they are shown, scene.js draws them.
import { contractKey, splitKey, resolvePointer, schemaProperties } from './core/resolve.ts';
import type { Contract } from '../../types/spec.d.ts';
import type { MergedSet } from '../../types/core.ts';
import type { AuthoredEnvelope, Chip, ContractDocs, Envelope, EnvelopeContext, EnvelopeSides, ObjectShape, Side, SideShape } from '../../types/viewer.ts';

/** Up to this many fields are listed; a longer schema shows MAX_FIELDS - 1 of them and «N more». */
export const MAX_FIELDS = 7;
export const SIDES: Side[] = ['request', 'response'];
export const SIDE_TITLE: Record<Side, string> = { request: 'request', response: 'response' };

/**
 * The envelope context: authored envelopes (`merged.envelopes`, keyed by doc + pointer) and the loaded contract
 * documents (Map doc → JSON). Envelopes are built once per key.
 */
export function envelopeContext(merged: Pick<MergedSet, 'envelopes'>, contractDocs: ContractDocs): EnvelopeContext {
    return { authored: (merged.envelopes ?? {}) as Record<string, AuthoredEnvelope>, docs: contractDocs, cache: new Map() };
}

/**
 * One envelope by its object key (`doc + pointer`): { key, title, authored, fields: [{ name, label }], total }.
 * Fields: the authored ones first, in the order the client layer lists them, then the schema's other properties under
 * their contract names. `total` = all properties (authored count when the schema is not loaded).
 */
export function envelopeOf(ctx: EnvelopeContext, key: string): Envelope {
    if (ctx.cache.has(key)) return ctx.cache.get(key)!;
    const { doc, pointer } = splitKey(key);
    const json = ctx.docs.get(doc);
    const schema = json ? resolvePointer(json, pointer) : undefined;
    const props = schema ? [...schemaProperties(json, schema)] : [];
    const a = ctx.authored[key];
    const labels = a?.fields ?? {};
    const fields = [
        ...Object.entries(labels).map(([name, label]) => ({ name, label })),
        ...props.filter((p) => !Object.hasOwn(labels, p)).map((name) => ({ name, label: name })),
    ];
    const env = { key, title: a?.title ?? (pointer.split('/').pop() || key), authored: !!a, fields, total: fields.length };
    ctx.cache.set(key, env);
    return env;
}

/** The fields an open envelope lists: all of them up to MAX_FIELDS, else MAX_FIELDS - 1 and how many more. */
export function shownFields(env: Envelope): { fields: Envelope['fields']; more: number } {
    if (env.fields.length <= MAX_FIELDS) return { fields: env.fields, more: 0 };
    return { fields: env.fields.slice(0, MAX_FIELDS - 1), more: env.fields.length - (MAX_FIELDS - 1) };
}

/** Envelopes of one contract (a scenario step's own): { request: [{ env, n }], response: [...] }. */
export function contractEnvelopes(ctx: EnvelopeContext, contract: Contract | null | undefined): EnvelopeSides {
    const out: EnvelopeSides = { request: [], response: [] };
    for (const side of SIDES) {
        const key = contractKey(contract, side);
        if (key) out[side].push({ env: envelopeOf(ctx, key), n: 1 });
    }
    return out;
}

/**
 * Envelopes carried by a set of relations (adapter edges with their effective `contract`): per side, distinct objects
 * with how many relations carry each; authored ones first (they are what the client layer names), then by count.
 */
export function edgesEnvelopes(ctx: EnvelopeContext, edges: { contract?: Contract | null }[]): EnvelopeSides {
    const out: EnvelopeSides = { request: [], response: [] };
    for (const side of SIDES) {
        const n = new Map<string, number>();
        for (const e of edges) {
            const key = contractKey(e.contract, side);
            if (key) n.set(key, (n.get(key) ?? 0) + 1);
        }
        out[side] = [...n]
            .map(([key, c]) => ({ env: envelopeOf(ctx, key), n: c }))
            .sort((x, y) => Number(y.env.authored) - Number(x.env.authored) || y.n - x.n || x.env.title.localeCompare(y.env.title));
    }
    return out;
}

/**
 * The chips a relation shows: at most one per side — the first envelope — and how many other objects travel on that
 * side (`others`, «+N» on the chip; the panel lists them all). Empty when the relation carries no contract.
 */
export function chipsOf(sides: EnvelopeSides, only: string | null = null): Chip[] {
    const chips: Chip[] = [];
    for (const side of SIDES) {
        const list = only ? sides[side].filter((x) => x.env.key === only) : sides[side];
        if (list.length) chips.push({ side, env: list[0].env, others: list.length - 1 });
    }
    return chips;
}

/** True when any of these relations carries a row-level policy (AD-9: effective `access.policies` non-empty). */
export const hasPolicies = (edges: { access?: { policies?: string[] } | null }[]): boolean => edges.some((e) => e.access?.policies?.length);

/** The relations (adapter edges) whose request or response is this object: «where else this shape travels». */
export const edgesWith = <E extends { contract?: Contract | null }>(edges: E[], key: string): E[] => edges.filter((e) => SIDES.some((s) => contractKey(e.contract, s) === key));

// ---------- the shape of an object: what a relation sends, field by field ----------
/** The part of a JSON Schema these helpers read (contract documents are open JSON). */
interface JsonSchema {
    $ref?: string;
    type?: string;
    format?: string;
    items?: unknown;
    enum?: unknown[];
    oneOf?: unknown[];
    anyOf?: unknown[];
    allOf?: unknown[];
    properties?: Record<string, unknown>;
    required?: string[];
}
interface FlatSchema {
    properties: Record<string, unknown>;
    required: string[];
}
interface ShapeOptions {
    max?: number;
    nested?: number;
}
/** Properties and required names of a schema, its local `$ref` and `allOf` parts merged. */
function flatSchema(doc: unknown, schema: unknown, depth = 0): FlatSchema {
    const out: FlatSchema = { properties: {}, required: [] };
    if (!schema || typeof schema !== 'object' || depth > 8) return out;
    const sch = schema as JsonSchema;
    const add = (s: FlatSchema) => (Object.assign(out.properties, s.properties), out.required.push(...s.required));
    if (typeof sch.$ref === 'string') add(flatSchema(doc, resolvePointer(doc, sch.$ref), depth + 1));
    for (const part of sch.allOf ?? []) add(flatSchema(doc, part, depth + 1));
    Object.assign(out.properties, sch.properties ?? {});
    out.required.push(...(sch.required ?? []));
    return out;
}
const refName = (ref: string): string | undefined => ref.split('/').pop();
/** A field's type as a short text: `number`, `string · date-time`, `DistanceMemberDto[]`, `'a' | 'b'`. */
export function typeText(schema: unknown): string {
    if (!schema || typeof schema !== 'object') return '';
    const s = schema as JsonSchema;
    if (s.$ref) return refName(s.$ref)!;
    if (s.type === 'array') return `${typeText(s.items) || 'any'}[]`;
    if (s.enum) {
        const v = s.enum.map((x) => (typeof x === 'string' ? `'${x}'` : String(x)));
        return v.length > 3 ? `${v.slice(0, 3).join(' | ')} | …` : v.join(' | ');
    }
    for (const k of ['oneOf', 'anyOf'] as const) if (s[k]) return s[k].map(typeText).join(' | ');
    if (s.allOf) return s.allOf.map(typeText).join(' & ');
    return [s.type ?? 'object', s.format].filter(Boolean).join(' · ');
}
/** The object a field holds (a `$ref`, an array of them, an inline object), for one level of nesting. */
function nestedOf(doc: unknown, schema: unknown): FlatSchema | null {
    if (!schema || typeof schema !== 'object') return null;
    const s = schema as JsonSchema;
    const inner = (s.type === 'array' ? s.items : s) as JsonSchema | undefined;
    if (!inner || typeof inner !== 'object') return null;
    if (inner.$ref || inner.allOf || inner.properties) {
        const f = flatSchema(doc, inner);
        return Object.keys(f.properties).length ? f : null;
    }
    return null;
}

/**
 * The shape of the object behind an envelope key (`doc + pointer`), for showing what a relation sends: the envelope's
 * title, the schema's name, and its fields — in the envelope's order (the client layer's names first), each with its
 * contract type, whether it is required, its human label, and for an object field its own first `nested` fields.
 * At most `max` fields; `more` counts the rest. `loaded: false` when the contract document is not loaded (`pending`: it is
 * on the way — the viewer loads contracts on first use).
 */
export function shapeOf(ctx: EnvelopeContext, key: string, { max = 9, nested = 4 }: ShapeOptions = {}): ObjectShape {
    const env = envelopeOf(ctx, key);
    const { doc, pointer } = splitKey(key);
    const json = ctx.docs.get(doc);
    const schema = json ? resolvePointer(json, pointer) : undefined;
    const flat: FlatSchema = json && schema ? flatSchema(json, schema) : { properties: {}, required: [] };
    const req = new Set(flat.required);
    const fields = env.fields.map(({ name, label }) => {
        const s = flat.properties[name];
        const sub = json ? nestedOf(json, s) : null;
        const kids = sub ? Object.entries(sub.properties) : [];
        const subReq = new Set(sub?.required ?? []);
        return {
            name,
            label: label !== name ? label : '',
            type: typeText(s),
            required: req.has(name),
            children: kids.slice(0, nested).map(([n, v]) => ({ name: n, type: typeText(v), required: subReq.has(n) })),
            childMore: Math.max(0, kids.length - nested),
        };
    });
    return { key, title: env.title, schemaName: refName(pointer) || key, fields: fields.slice(0, max), more: Math.max(0, fields.length - max), loaded: !!schema, pending: !json && !!ctx.docs.pending?.(doc) };
}

/** The shapes a contract sends: [{ side, shape }] for its request and its response. */
export const contractShapes = (ctx: EnvelopeContext, contract: Contract | null | undefined, opts?: ShapeOptions): SideShape[] => SIDES.flatMap((side) => (contractKey(contract, side) ? [{ side, shape: shapeOf(ctx, contractKey(contract, side)!, opts) }] : []));
