// The supabase-js shape scanner shared by the code extractors of the Supabase stack (Edge Functions, the React client app): fold an
// expression to a literal when the code says what it is, and recognise the client calls `.from(t).<op>()`,
// `.schema(s).from(t)`, `.rpc(fn)`, `.storage.from(bucket).<op>()`, `.functions.invoke(name)`, `.auth.<call>()`. The
// client usually comes from imports the compiler cannot type (`jsr:` / `npm:`), so calls are matched by shape — and kept
// only when the argument folds to a name; what does not fold is reported, never guessed. Pure, no I/O.
import type * as TS from 'typescript';
import type { Ts } from '../../../types/generator.ts';
import type { SupabaseCall, Value, Values } from '../../../types/stacks/supabase.ts';

export const READ_OPS = new Set(['select']);
export const WRITE_OPS = new Set(['insert', 'update', 'upsert', 'delete']);
export const BUCKET_READ = new Set(['download', 'list', 'createSignedUrl', 'createSignedUrls', 'getPublicUrl', 'exists', 'info']);
export const BUCKET_WRITE = new Set(['upload', 'update', 'remove', 'move', 'copy', 'createSignedUploadUrl', 'uploadToSignedUrl']);

/** Value folding over one program: { strip, symbolOf, declOfCallee, valueOf, name }. */
export function makeValues(ts: Ts, checker: TS.TypeChecker): Values {
    const symbolOf = (node: TS.Node): TS.Symbol | undefined => {
        let s = checker.getSymbolAtLocation(node);
        if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
        return s;
    };
    function strip(e: TS.Expression): TS.Expression;
    function strip(e: TS.Expression | undefined): TS.Expression | undefined;
    function strip(e: TS.Expression | undefined): TS.Expression | undefined {
        while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression?.(e) || ts.isSatisfiesExpression?.(e))) e = e.expression;
        return e;
    }
    /** a literal value of an expression, or undefined; `depth` stops cycles */
    function valueOf(e: TS.Expression | undefined, depth = 0): Value {
        e = strip(e);
        if (!e || depth > 8) return undefined;
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
        if (ts.isNumericLiteral(e)) return Number(e.text);
        if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
        if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => valueOf(x, depth + 1));
        if (ts.isObjectLiteralExpression(e)) {
            const o: Record<string, Value> = {};
            for (const p of e.properties) {
                if (ts.isPropertyAssignment(p)) o[p.name.getText().replace(/^['"]|['"]$/g, '')] = valueOf(p.initializer, depth + 1);
                else if (ts.isShorthandPropertyAssignment(p)) o[p.name.text] = valueOf(p.name, depth + 1);
                else if (ts.isSpreadAssignment(p)) Object.assign(o, valueOf(p.expression, depth + 1) ?? {});
            }
            return o;
        }
        if (ts.isTemplateExpression(e)) {
            let s = e.head.text;
            for (const span of e.templateSpans) {
                const v = valueOf(span.expression, depth + 1);
                s += (typeof v === 'string' || typeof v === 'number' ? String(v) : '${*}') + span.literal.text;
            }
            return s;
        }
        if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isIdentifier(e)) {
            const c = ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? checker.getConstantValue(e) : undefined; // enum members
            if (c !== undefined) return c;
            const s = symbolOf(ts.isElementAccessExpression(e) ? e.argumentExpression : ts.isPropertyAccessExpression(e) ? e.name : e);
            const d = s?.valueDeclaration ?? s?.declarations?.[0];
            if (d && ts.isEnumMember(d)) return checker.getConstantValue(d);
            if (d && (ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) {
                if (ts.isVariableDeclaration(d) && !(d.parent.flags & ts.NodeFlags.Const)) return undefined;
                return valueOf(d.initializer, depth + 1);
            }
            if (d && ts.isShorthandPropertyAssignment(d)) return valueOf(d.name, depth + 1);
            // `table.user` on a const typed `Record<…>`: the checker answers with the index signature; read the literal
            if (ts.isPropertyAccessExpression(e)) {
                const obj = valueOf(e.expression, depth + 1);
                if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.hasOwn(obj, e.name.text)) return obj[e.name.text];
            }
        }
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const a = valueOf(e.left, depth + 1);
            const b = valueOf(e.right, depth + 1);
            return `${typeof a === 'string' || typeof a === 'number' ? a : '${*}'}${typeof b === 'string' || typeof b === 'number' ? b : '${*}'}`;
        }
        return undefined;
    }
    const name = (e: TS.Expression | undefined): string | undefined => {
        const v = valueOf(e);
        return typeof v === 'string' && /^[A-Za-z_][\w]*$/.test(v) ? v : undefined;
    };
    const declOfCallee = (callee: TS.Expression): TS.Declaration | undefined => {
        const s = symbolOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
        return s?.valueDeclaration ?? s?.declarations?.[0];
    };
    return { strip, symbolOf, declOfCallee, valueOf, name };
}

/**
 * What one call expression is, as a supabase-js call, or null when it is none of them:
 *   { kind: 'bucket', bucket, access, op } | { kind: 'table', schema, table, op } | { kind: 'rpc', schema, fn }
 *   | { kind: 'unresolved', code, expr }   — the shape matched but the name did not fold
 *   | { kind: 'skip' }                     — a supabase-js call that reaches nothing (`.from(b).<other op>`)
 * With `extra: true` also `.functions.invoke(name, opts)` → { kind: 'invoke', name?, method? } and `.auth.<…>()` →
 * { kind: 'auth', call } (the Edge Functions use neither; their output stays as it was).
 */
export function supabaseCall(ts: Ts, vals: Values, call: TS.Node, { extra = false }: { extra?: boolean } = {}): SupabaseCall | null {
    const { strip, valueOf, name } = vals;
    if (!ts.isCallExpression(call)) return null;
    const callee = strip(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const args = call.arguments ?? [];
    const short = (node: TS.Node, n = 140) => node.getText().replace(/\s+/g, ' ').slice(0, n);
    const m = callee.name.text;
    const recv = strip(callee.expression);
    /** `.from(x)` chain: the method called on its result (`select`, `insert`, …) */
    const chainOp = (c: TS.Node): string | undefined => (ts.isPropertyAccessExpression(c.parent) ? c.parent.name.text : undefined);
    /** `.schema('x').from(…)`: the schema */
    const schemaOf = (r: TS.Expression): string | undefined => {
        const x = strip(r);
        if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'schema') return name(x.arguments[0]);
        return undefined;
    };
    // storage.from('bucket').<op>()
    if (m === 'from' && ts.isPropertyAccessExpression(recv) && recv.name.text === 'storage') {
        const b = valueOf(args[0]);
        const op = chainOp(call);
        if (typeof b === 'string') {
            const access = BUCKET_WRITE.has(op ?? '') ? 'write' : BUCKET_READ.has(op ?? '') ? 'read' : undefined;
            return access ? { kind: 'bucket', bucket: b, access, op: op! /* access is set only for a known op */ } : { kind: 'skip' };
        }
        return { kind: 'unresolved', code: 'dynamic-bucket', expr: short(call) };
    }
    // <client>.from(table).<op>()
    if (m === 'from' && args.length === 1) {
        const t = name(args[0]);
        const op = chainOp(call);
        if (t && op && (READ_OPS.has(op) || WRITE_OPS.has(op))) return { kind: 'table', schema: schemaOf(recv) ?? 'public', table: t, op };
        if (t && op) return { kind: 'unresolved', code: 'table-op', expr: `.from(${t}).${op}()` };
        if (!t && (READ_OPS.has(op ?? '') || WRITE_OPS.has(op ?? ''))) return { kind: 'unresolved', code: 'dynamic-table', expr: short(call) };
        return { kind: 'skip' };
    }
    // <client>.rpc('fn')
    if (m === 'rpc' && args.length >= 1) {
        const f = name(args[0]);
        return f ? { kind: 'rpc', schema: schemaOf(recv) ?? 'public', fn: f } : { kind: 'unresolved', code: 'dynamic-rpc', expr: short(call) };
    }
    if (!extra) return null;
    // <client>.functions.invoke('name', { method })
    if (m === 'invoke' && ts.isPropertyAccessExpression(recv) && recv.name.text === 'functions') {
        const opts = valueOf(args[1]);
        return { kind: 'invoke', name: valueOf(args[0]), method: typeof (opts as { method?: Value } | undefined)?.method === 'string' ? ((opts as { method: string }).method).toUpperCase() : undefined, arg: args[0], expr: short(call) };
    }
    // <client>.auth.<call>() and <client>.auth.mfa.<call>()
    const authPath: string[] = [];
    for (let r: TS.Expression = recv; r && ts.isPropertyAccessExpression(r); r = strip(r.expression)) {
        authPath.unshift(r.name.text);
        if (r.name.text === 'auth') return { kind: 'auth', call: [...authPath.slice(1), m].join('.') };
    }
    return null;
}
