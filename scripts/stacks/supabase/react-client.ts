// What a React + supabase-js client app does: one TypeScript program over its src/, read with
// the compiler API. Pure analysis, no spec shapes:
//   - routes: `src/app/routes.tsx` followed through arrays, spreads and `children`; a route's path is evaluated
//     (`paths.jobMatch(':id').replace('%3Aid', ':id')` → `/jobs/:id/match`), its screen is the `lazy` import target;
//   - port implementations: object literals whose contextual type is a port (`*Port`, `*Provider` interfaces of
//     `src/api/resources/<domain>/`) in the live code — `liveAdapter<XPort>('x', {…})`, `const port: XPort = {…}`,
//     `return {…}` of a function returning a port, and the objects spread into them; a property = a port method;
//   - what each port method does: supabase-js calls by shape (shared scanner, supabase-js.ts), Edge Function calls
//     through the configured wrapper (`invokeEdge(client, name, { method })`), Auth calls, fetch() to outside hosts,
//     calls of other ports' methods and of the seam (`src/api/live/*`), folded through local helpers with their
//     arguments bound (so `upload(file, 'video')` reaches `/video` only); a method that only rejects with
//     «scheduled in story …» is a stub (pending live);
//   - what each screen reaches: the port members its file and the files it imports (not other screens, not src/api)
//     reach through hooks (screen → resources/<d>/index.ts → queries.ts → port member), any number of hops.
// `registerTables(…)` lists (cache invalidation) are never read as access: tables come only from supabase-js calls.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';
import { makeValues, supabaseCall } from './supabase-js.ts';
import type * as TS from 'typescript';
import type { Ts } from '../../../types/generator.ts';
import type { ReactClientAnalysis, CandEffect, CandPort, CandRef, CandRoot, CandSeam, CandSite, StringArg, SupabaseConfig, Value } from '../../../types/stacks/supabase.ts';

/** A function-like node a unit runs. */
type FnLike = TS.FunctionDeclaration | TS.MethodDeclaration | TS.ArrowFunction | TS.FunctionExpression;
/** A declaration that may carry an initializer (a variable, a property, a parameter). */
type WithInitializer = TS.Node & { initializer?: TS.Expression };
/** A call a unit makes: of a port method, of the seam, or of a local helper (with its arguments). */
interface UnitCall {
    port?: string;
    seam?: CandUnit;
    helper?: CandUnit;
    args?: TS.Expression[];
    site: CandSite;
}
/** A unit of the live code: a named function, a method, a function-valued property. */
interface CandUnit {
    key: string;
    file: string;
    name: string;
    line: number;
    node: TS.Node;
    fn: FnLike;
    params: (string | null)[];
    effects: CandEffect[];
    calls: UnitCall[];
}
/** What running a unit does, its local helpers folded in. */
interface Folded {
    effects: CandEffect[];
    calls: UnitCall[];
}

function listFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === 'node_modules' || name === 'test' || name === '__tests__') continue;
            listFiles(p, out);
        } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

/**
 * @param ts the typescript module
 * @param root absolute path of the client app's checkout
 * @param cfg `REACT_CLIENT` of the project config
 */
export function analyzeReactClient(ts: Ts, root: string, cfg: SupabaseConfig['REACT_CLIENT']): ReactClientAnalysis {
    const rel = (p: string): string => relative(root, p).split(sep).join('/');
    const files = listFiles(join(root, cfg.SRC));
    const tsconfig = join(root, cfg.TSCONFIG);
    const parsed: { options: TS.CompilerOptions } = existsSync(tsconfig) ? ts.parseJsonConfigFileContent(ts.readConfigFile(tsconfig, ts.sys.readFile).config, ts.sys, root) : { options: {} };
    const program = ts.createProgram(files, { ...parsed.options, noEmit: true, types: [], skipLibCheck: true, noResolve: true, composite: false, tsBuildInfoFile: undefined, incremental: false });
    const checker = program.getTypeChecker();
    const vals = makeValues(ts, checker);
    const { strip, symbolOf, declOfCallee, valueOf } = vals;
    const ours = new Set(files);
    const sources = program.getSourceFiles().filter((sf) => ours.has(sf.fileName)).sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
    const fileOf = (node: TS.Node): string => rel(node.getSourceFile().fileName);
    const lineOf = (node: TS.Node): number => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const short = (node: TS.Node, n = 140): string => node.getText().replace(/\s+/g, ' ').slice(0, n);
    const RES = `${cfg.SRC}/${cfg.RESOURCES}/`;
    const SEAM = `${cfg.SRC}/${cfg.SEAM}/`;
    const API = `${cfg.SRC}/api/`;
    const isMock = (f: string): boolean => cfg.MOCK.test(f);
    const domainOfFile = (f: string): string | undefined => (f.startsWith(RES) ? f.slice(RES.length).split('/')[0] : undefined);
    /** live code: the resources' adapters and the seam, never the mocks */
    const isLive = (f: string): boolean => (f.startsWith(RES) || f.startsWith(SEAM)) && !isMock(f);
    const declOf = (s: TS.Symbol | undefined): TS.Declaration | undefined => s?.valueDeclaration ?? s?.declarations?.[0];

    // ---------- units of the live code: named functions, methods, function-valued properties ----------
    const isFn = (n: TS.Node | undefined): n is TS.ArrowFunction | TS.FunctionExpression => n !== undefined && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
    const unitOfNode = new Map<TS.Node, CandUnit>(); // declaration node → unit
    const units: CandUnit[] = [];
    const addUnit = (node: TS.Node, name: string, fn: FnLike): CandUnit => {
        const u: CandUnit = { key: `${fileOf(node)}#${name}@${lineOf(node)}`, file: fileOf(node), name, line: lineOf(node), node, fn, params: (fn.parameters ?? []).map((p) => (ts.isIdentifier(p.name) ? p.name.text : null)), effects: [], calls: [] };
        units.push(u);
        unitOfNode.set(node, u);
        unitOfNode.set(fn, u);
        return u;
    };
    for (const sf of sources) {
        const f = rel(sf.fileName);
        if (!isLive(f) && !(f.startsWith(API) && !isMock(f))) continue;
        const visit = (n: TS.Node): void => {
            if (ts.isFunctionDeclaration(n) && n.name && n.body) addUnit(n, n.name.text, n);
            else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isFn(strip(n.initializer))) addUnit(n, n.name.text, strip(n.initializer) as FnLike);
            else if (ts.isMethodDeclaration(n) && n.body && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) addUnit(n, n.name.text, n);
            else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && isFn(strip(n.initializer))) addUnit(n, n.name.text, strip(n.initializer) as FnLike);
            ts.forEachChild(n, visit);
        };
        visit(sf);
    }
    const unitOfDecl = (d: WithInitializer | undefined): CandUnit | undefined => d && (unitOfNode.get(d) ?? (d.initializer && unitOfNode.get(strip(d.initializer))));

    // ---------- ports: interfaces and their implementations ----------
    const portName = (n: unknown): boolean => typeof n === 'string' && cfg.PORT_TYPES.test(n);
    /** a member signature of a port interface → { domain, member } */
    const portMember = (d: TS.Node | undefined): { domain: string; member: string } | undefined => {
        if (!d || !(ts.isMethodSignature(d) || ts.isPropertySignature(d))) return undefined;
        const owner = d.parent;
        const name = ts.isInterfaceDeclaration(owner) ? owner.name.text : ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent) ? owner.parent.name.text : undefined;
        const domain = domainOfFile(fileOf(d));
        return portName(name) && domain ? { domain, member: d.name.getText() } : undefined;
    };
    const typeIsPort = (t: TS.Type | undefined, depth = 0): boolean => {
        if (!t || depth > 3) return false;
        if (portName(t.aliasSymbol?.name) || portName(t.symbol?.name)) return true;
        return ((t as TS.UnionOrIntersectionType).types ?? []).some((x) => typeIsPort(x, depth + 1));
    };
    /** port methods: `${domain}#${name}` → { domain, name, units: [unit], line, file } */
    const portMethods = new Map<string, { domain: string; name: string; units: CandUnit[]; line: number; file: string }>();
    const addPortMethod = (domain: string, name: string, unit: CandUnit | undefined, at: TS.Node): void => {
        const k = `${domain}#${name}`;
        const pm = portMethods.get(k) ?? portMethods.set(k, { domain, name, units: [], line: lineOf(at), file: fileOf(at) }).get(k)!;
        if (unit && !pm.units.includes(unit)) pm.units.push(unit);
    };
    const seenObj = new Set<TS.ObjectLiteralExpression>();
    function implObject(obj: TS.ObjectLiteralExpression | undefined, domain: string, depth = 0): void {
        if (!obj || seenObj.has(obj) || depth > 4) return;
        seenObj.add(obj);
        for (const p of obj.properties) {
            if (ts.isSpreadAssignment(p)) {
                for (const o of returnedObjects(strip(p.expression))) implObject(o, domain, depth + 1);
                continue;
            }
            const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
            if (!name || name.startsWith('__')) continue;
            let unit: CandUnit | undefined;
            if (ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && isFn(strip(p.initializer)))) unit = unitOfNode.get(p);
            else if (ts.isPropertyAssignment(p) && ts.isIdentifier(strip(p.initializer))) unit = unitOfDecl(declOf(symbolOf(strip(p.initializer))));
            else if (ts.isShorthandPropertyAssignment(p)) unit = unitOfDecl(declOf(checker.getShorthandAssignmentValueSymbol(p)));
            addPortMethod(domain, name, unit, p);
        }
    }
    /** the object literals an expression evaluates to: a literal, a variable's, a function's `return {…}` */
    function returnedObjects(expr: TS.Expression | undefined, depth = 0): TS.ObjectLiteralExpression[] {
        const e = strip(expr);
        if (!e || depth > 3) return [];
        if (ts.isObjectLiteralExpression(e)) return [e];
        if (ts.isIdentifier(e)) {
            const d = declOf(symbolOf(e));
            return d && ts.isVariableDeclaration(d) && d.initializer ? returnedObjects(d.initializer, depth + 1) : [];
        }
        if (ts.isCallExpression(e)) {
            const d = declOfCallee(strip(e.expression)) as WithInitializer | undefined;
            const fn = d && (ts.isFunctionDeclaration(d) ? d : isFn(strip(d.initializer)) ? (strip(d.initializer) as FnLike) : undefined);
            if (!fn?.body) return [];
            if (!ts.isBlock(fn.body)) return returnedObjects(fn.body as TS.Expression, depth + 1);
            const out: TS.ObjectLiteralExpression[] = [];
            const walk = (n: TS.Node): void => {
                if (ts.isReturnStatement(n) && n.expression) out.push(...returnedObjects(n.expression, depth + 1));
                if (!isFn(n) && !ts.isFunctionDeclaration(n)) ts.forEachChild(n, walk);
            };
            fn.body.statements.forEach(walk);
            return out;
        }
        return [];
    }
    for (const sf of sources) {
        const f = rel(sf.fileName);
        const domain = domainOfFile(f);
        if (!domain || isMock(f)) continue;
        const visit = (n: TS.Node): void => {
            if (ts.isObjectLiteralExpression(n) && typeIsPort(checker.getContextualType(n))) implObject(n, domain);
            ts.forEachChild(n, visit);
        };
        visit(sf);
    }
    const unitPort = new Map<CandUnit, string>(); // unit → port method key
    for (const [k, pm] of portMethods) for (const u of pm.units) if (!unitPort.has(u)) unitPort.set(u, k);

    // ---------- what each unit does itself ----------
    const helperCfg: Record<string, { nameArg: number; optionsArg: number; defaultMethod: string }> = cfg.EDGE_HELPERS;
    const isFetch = (callee: TS.Expression): boolean => {
        if (!ts.isIdentifier(callee)) return false;
        if (callee.text === 'fetch') return true;
        const d = declOf(symbolOf(callee)); // `request: typeof fetch = fetch`
        return !!(d && ts.isParameter(d) && d.initializer && ts.isIdentifier(d.initializer) && d.initializer.text === 'fetch');
    };
    /** a string argument: literal, else the name of a parameter of the unit (bound by the caller), else the string literals of its type */
    const stringArg = (u: CandUnit, arg: TS.Expression | undefined): StringArg => {
        const v = valueOf(arg);
        if (typeof v === 'string') return { value: v };
        const a = strip(arg);
        if (a && ts.isIdentifier(a)) {
            const d = declOf(symbolOf(a));
            if (d && ts.isParameter(d) && ts.isIdentifier(d.name) && u.params.includes(d.name.text)) return { param: d.name.text, union: literalUnion(a) };
        }
        return { union: literalUnion(a) };
    };
    const literalUnion = (node: TS.Node | undefined): string[] | undefined => {
        if (!node) return undefined;
        const t = checker.getTypeAtLocation(node);
        const parts = t.isUnion?.() ? t.types : [t];
        const lits = parts.map((x) => (x.isStringLiteral?.() ? x.value : undefined));
        return lits.every((x) => typeof x === 'string') ? (lits as string[]).sort() : undefined;
    };
    for (const u of units) {
        if (Object.hasOwn(helperCfg, u.name) && u.file.startsWith(SEAM)) continue; // the wrapper itself: its callers say where
        const walk = (n: TS.Node): void => {
            if (n !== u.fn && unitOfNode.has(n) && n !== u.node) return; // a nested unit is its own
            if (ts.isCallExpression(n)) onCall(u, n);
            ts.forEachChild(n, walk);
        };
        ts.forEachChild(u.fn, walk);
    }
    function onCall(u: CandUnit, call: TS.CallExpression): void {
        const line = lineOf(call);
        const site: CandSite = { file: fileOf(call), line };
        const sb = supabaseCall(ts, vals, call, { extra: true });
        if (sb && sb.kind !== 'skip') {
            if (sb.kind === 'invoke') u.effects.push({ kind: 'edge', name: typeof sb.name === 'string' ? { value: sb.name } : stringArg(u, sb.arg), method: sb.method, site, expr: sb.expr });
            else if (sb.kind === 'unresolved') u.effects.push({ kind: 'unresolved', code: sb.code, expr: sb.expr, site });
            else u.effects.push({ ...sb, site });
            return;
        }
        if (sb) return;
        const callee = strip(call.expression);
        const args = call.arguments;
        const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        const decl = declOfCallee(callee);
        // the Edge Function wrapper (`invokeEdge(client, 'name', { method })`)
        if (Object.hasOwn(helperCfg, calleeName) && decl && fileOf(decl).startsWith(SEAM)) {
            const h = helperCfg[calleeName];
            const opts = valueOf(args[h.optionsArg]);
            const method = (opts as { method?: unknown } | undefined)?.method;
            u.effects.push({ kind: 'edge', name: stringArg(u, args[h.nameArg]), method: typeof method === 'string' ? method.toUpperCase() : h.defaultMethod, site, expr: short(call) });
            return;
        }
        if (isFetch(callee) && args.length) {
            const url = valueOf(args[0]);
            u.effects.push({ kind: 'fetch', url: typeof url === 'string' ? url : null, site, expr: short(call) });
            return;
        }
        // a port member (another domain's port, or this one's own) → a call of that port method
        const pmem = portMember(decl);
        if (pmem) {
            u.calls.push({ port: `${pmem.domain}#${pmem.member}`, site });
            return;
        }
        const target = unitOfDecl(decl as WithInitializer | undefined);
        if (!target || target === u) return;
        if (unitPort.has(target)) u.calls.push({ port: unitPort.get(target), site });
        else if (target.file.startsWith(SEAM)) u.calls.push({ seam: target, site });
        else u.calls.push({ helper: target, args: [...args], site });
    }

    // ---------- folded effects: a unit's own, and its local helpers' with their arguments bound ----------
    /** → { effects: [...], calls: [{ port } | { seam }] } of running `u` with params bound to `env` */
    function fold(u: CandUnit, env: Record<string, string | undefined> = {}, stack = new Set<CandUnit>()): Folded {
        const out: Folded = { effects: [], calls: [] };
        if (stack.has(u) || stack.size > 8) return out;
        stack.add(u);
        for (const e of u.effects) {
            if (e.kind === 'edge' && e.name.param && typeof env[e.name.param] === 'string') out.effects.push({ ...e, name: { value: env[e.name.param] } });
            else out.effects.push(e);
        }
        for (const c of u.calls) {
            if (!c.helper) {
                out.calls.push(c);
                continue;
            }
            const inner: Record<string, string | undefined> = {};
            const args = c.args!; // a helper call carries its arguments
            c.helper.params.forEach((p, i) => {
                if (!p || !args[i]) return;
                const v = valueOf(args[i]);
                const a = strip(args[i]);
                inner[p] = typeof v === 'string' ? v : a && ts.isIdentifier(a) && typeof env[a.text] === 'string' ? env[a.text] : undefined;
            });
            const sub = fold(c.helper, inner, stack);
            out.effects.push(...sub.effects);
            out.calls.push(...sub.calls);
        }
        stack.delete(u);
        return out;
    }
    /** a stub: rejects with an ApiError and does nothing else → its message */
    const stubMessage = (u: CandUnit): string | undefined => {
        let msg: string | undefined;
        const walk = (n: TS.Node): void => {
            if (msg) return;
            if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === cfg.STUB.error && ts.isCallExpression(n.parent) && /\breject$/.test(n.parent.expression.getText())) {
                const m = valueOf(n.arguments?.[1]);
                if (typeof m === 'string' && cfg.STUB.message.test(m)) msg = m;
            }
            ts.forEachChild(n, walk);
        };
        walk(u.fn);
        return msg;
    };

    // `calls` hold UnitCalls until the seam pass below turns them into CandRefs
    const ports: (Omit<CandPort, 'calls'> & { calls: UnitCall[] })[] = [];
    for (const [k, pm] of [...portMethods].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const folded: Folded = { effects: [], calls: [] };
        for (const u of pm.units) {
            const f = fold(u);
            folded.effects.push(...f.effects);
            folded.calls.push(...f.calls);
        }
        const stub = !folded.effects.length && !folded.calls.length && pm.units.length ? pm.units.map(stubMessage).find(Boolean) : undefined;
        ports.push({ key: k, domain: pm.domain, name: pm.name, file: pm.units[0]?.file ?? pm.file, line: pm.units[0]?.line ?? pm.line, ...folded, stub });
    }
    const seam = units.filter((u) => u.file.startsWith(SEAM) && !Object.hasOwn(helperCfg, u.name)).map((u) => ({ key: u.key, name: u.name, file: u.file, line: u.line, ...fold(u) }));
    const seamOf = new Map(units.filter((u) => u.file.startsWith(SEAM)).map((u) => [u, seam.find((s) => s.key === u.key)]));
    for (const p of [...ports, ...seam])
        (p as { calls: CandRef[] }).calls = p.calls.map((c): CandRef => (c.seam ? { seam: seamOf.get(c.seam)?.key, site: c.site } : (c as CandRef))).filter((c) => c.port || c.seam);

    // ---------- routes ----------
    const sfByRel = new Map(sources.map((sf) => [rel(sf.fileName), sf]));
    const resolveImport = (fromFile: string, spec: string): string | undefined => {
        let base: string;
        if (spec.startsWith('@/')) base = join(root, cfg.SRC, spec.slice(2));
        else if (spec.startsWith('.')) base = resolve(dirname(join(root, fromFile)), spec);
        else return undefined;
        for (const c of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) if (sfByRel.has(rel(c))) return rel(c);
        return undefined;
    };
    /** a path or title: literals, `paths.x`, `paths.x(':id')` (the arrow evaluated with its argument), `.replace(a, b)`, `obj['k']` */
    const BUILTINS: Record<string, (s: string) => string> = { encodeURIComponent, decodeURIComponent };
    function evaluate(expr: TS.Expression | undefined, env = new Map<TS.Node, Value>(), depth = 0): Value {
        const e = strip(expr);
        if (!e || depth > 10) return undefined;
        if (ts.isIdentifier(e)) {
            const d = declOf(symbolOf(e));
            if (d && env.has(d)) return env.get(d);
        }
        if (ts.isTemplateExpression(e)) {
            let s = e.head.text;
            for (const span of e.templateSpans) {
                const v = evaluate(span.expression, env, depth + 1);
                if (typeof v !== 'string' && typeof v !== 'number') return undefined;
                s += String(v) + span.literal.text;
            }
            return s;
        }
        if (ts.isElementAccessExpression(e)) {
            const obj = valueOf(e.expression);
            const k = evaluate(e.argumentExpression, env, depth + 1);
            if (obj && typeof obj === 'object' && typeof k === 'string' && Object.hasOwn(obj, k)) return (obj as Record<string, Value>)[k];
        }
        if (ts.isCallExpression(e)) {
            const callee = strip(e.expression);
            const args = e.arguments.map((a) => evaluate(a, env, depth + 1));
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'replace') {
                const s = evaluate(callee.expression, env, depth + 1);
                return typeof s === 'string' && typeof args[0] === 'string' && typeof args[1] === 'string' ? s.replace(args[0], args[1]) : undefined;
            }
            if (ts.isIdentifier(callee) && Object.hasOwn(BUILTINS, callee.text) && typeof args[0] === 'string') return BUILTINS[callee.text](args[0]);
            const d = declOfCallee(callee) as WithInitializer | undefined;
            const fn = d && (ts.isFunctionDeclaration(d) ? d : isFn(strip(d.initializer)) ? (strip(d.initializer) as FnLike) : undefined);
            if (fn && fn.body && !ts.isBlock(fn.body)) {
                const inner = new Map(env);
                fn.parameters.forEach((p, i) => inner.set(p, args[i]));
                return evaluate(fn.body as TS.Expression, inner, depth + 1);
            }
            return undefined;
        }
        return valueOf(e);
    }
    const routes: ReactClientAnalysis['routes'] = [];
    const routeIssues: ReactClientAnalysis['routeIssues'] = [];
    function routeList(expr: TS.Expression | undefined, file: string, depth = 0): void {
        const e = strip(expr);
        if (!e || depth > 6) return;
        if (ts.isArrayLiteralExpression(e)) {
            for (const x of e.elements) {
                if (ts.isSpreadElement(x)) routeList(x.expression, file, depth + 1);
                else routeObject(strip(x), file, depth);
            }
        } else if (ts.isIdentifier(e)) {
            const d = declOf(symbolOf(e));
            if (d && ts.isVariableDeclaration(d) && d.initializer) routeList(d.initializer, fileOf(d), depth + 1);
        }
    }
    function routeObject(o: TS.Expression | undefined, file: string, depth: number): void {
        if (!o || !ts.isObjectLiteralExpression(o)) return;
        const prop = (n: string): TS.Expression | undefined => (o.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === n) as TS.PropertyAssignment | undefined)?.initializer;
        if (prop('children')) routeList(prop('children'), file, depth + 1);
        const lazy = strip(prop('lazy'));
        if (!lazy) return;
        let spec: Value;
        const walk = (n: TS.Node): void => {
            if (!spec && ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) spec = valueOf(n.arguments[0]);
            if (!spec) ts.forEachChild(n, walk);
        };
        walk(lazy);
        const path = evaluate(prop('path'));
        const handle = strip(prop('handle'));
        const h = new Map(handle && ts.isObjectLiteralExpression(handle) ? handle.properties.filter(ts.isPropertyAssignment).map((p): [string, TS.Expression] => [p.name.getText(), p.initializer]) : []);
        const screen = typeof spec === 'string' ? resolveImport(fileOf(o), spec) : undefined;
        if (typeof path !== 'string' || !screen) {
            routeIssues.push({ kind: 'route', file: fileOf(o), line: lineOf(o), expr: short(o) });
            return;
        }
        routes.push({ path, title: evaluate(h.get('title')), owner: valueOf(h.get('owner')), nav: valueOf(h.get('nav')), screen, file: fileOf(o), line: lineOf(o) });
    }
    const routesSf = sfByRel.get(`${cfg.SRC}/${cfg.ROUTES}`);
    if (routesSf) {
        for (const st of routesSf.statements) {
            if (!ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === cfg.ROUTES_EXPORT) routeList(d.initializer, rel(routesSf.fileName));
        }
    }

    // ---------- what screens and the app shell reach ----------
    const screenFiles = [...new Set(routes.map((r) => r.screen))].sort();
    const appFiles = sources.map((sf) => rel(sf.fileName)).filter((f) => cfg.APP_ROOTS.test(f) && !cfg.APP_SKIP.test(f) && !screenFiles.includes(f));
    const rootFiles = new Set([...screenFiles, ...appFiles]);
    const importsOf = (f: string): string[] => {
        const sf = sfByRel.get(f)!;
        const out: Value[] = [];
        const walk = (n: TS.Node): void => {
            if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && !(n as TS.ImportDeclaration).importClause?.isTypeOnly && !(n as TS.ExportDeclaration).isTypeOnly) out.push(valueOf(n.moduleSpecifier));
            else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) out.push(valueOf(n.arguments[0]));
            ts.forEachChild(n, walk);
        };
        walk(sf);
        return out.filter((x) => typeof x === 'string').map((s) => resolveImport(f, s)).filter((x): x is string => Boolean(x));
    };
    /** port members reached from a declaration in src/api (hooks, query factories), memoised */
    const reachMemo = new Map<TS.Node, Map<string, CandSite>>();
    function reachOfDecl(d: WithInitializer, stack = new Set<TS.Node>()): Map<string, CandSite> {
        if (reachMemo.has(d)) return reachMemo.get(d)!;
        if (stack.has(d) || stack.size > 12) return new Map();
        stack.add(d);
        const out = new Map<string, CandSite>(); // port key → first site
        const body = ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) ? d : isFn(strip(d.initializer)) ? strip(d.initializer) : undefined;
        if (body) collectRefs(body, out, stack);
        stack.delete(d);
        reachMemo.set(d, out);
        return out;
    }
    function collectRefs(node: TS.Node, out: Map<string, CandSite>, stack: Set<TS.Node>): void {
        const walk = (n: TS.Node): void => {
            if (ts.isIdentifier(n) && !(n.parent && ts.isImportSpecifier(n.parent))) {
                const d = declOf(symbolOf(n));
                if (d) {
                    const f = fileOf(d);
                    const pm = portMember(d);
                    const site = { file: fileOf(n), line: lineOf(n) };
                    if (pm) {
                        const k = `${pm.domain}#${pm.member}`;
                        if (!out.has(k)) out.set(k, site);
                    } else if (f.startsWith(API) && !isMock(f) && ts.isBindingElement(d) && ts.isVariableDeclaration(d.parent.parent) && d.parent.parent.initializer) {
                        // `export const { useEnumValues } = createDictionariesQueries(port)`: the property of the returned object
                        const key = (d.propertyName ?? d.name).getText();
                        for (const o of returnedObjects(d.parent.parent.initializer)) {
                            const p = o.properties.find((x) => x.name?.getText() === key);
                            const target = !p ? undefined : ts.isShorthandPropertyAssignment(p) ? declOf(checker.getShorthandAssignmentValueSymbol(p)) : p;
                            if (target) for (const [k] of reachOfDecl(target, stack)) if (!out.has(k)) out.set(k, site);
                        }
                    } else if (f.startsWith(API) && !isMock(f) && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || (ts.isVariableDeclaration(d) && isFn(strip(d.initializer))) || (ts.isPropertyAssignment(d) && isFn(strip(d.initializer))))) {
                        for (const [k] of reachOfDecl(d, stack)) if (!out.has(k)) out.set(k, site);
                    }
                }
            }
            ts.forEachChild(n, walk);
        };
        walk(node);
    }
    const reachOfRoot = (f: string): Map<string, CandSite> => {
        const seen = new Set([f]);
        const queue = [f];
        const out = new Map<string, CandSite>();
        while (queue.length) {
            const x = queue.shift()!;
            collectRefs(sfByRel.get(x)!, out, new Set());
            for (const y of importsOf(x))
                if (!seen.has(y) && !rootFiles.has(y) && !y.startsWith(API) && !cfg.APP_SKIP.test(y)) {
                    seen.add(y);
                    queue.push(y);
                }
        }
        return out;
    };
    /** the component a root file exports: `Component` (react-router lazy), else the first exported function */
    const mainExport = (f: string): { name: string; line: number } => {
        const sf = sfByRel.get(f)!;
        const exported: { name: string; line: number }[] = [];
        for (const st of sf.statements) {
            const isExp = (st as { modifiers?: TS.NodeArray<TS.ModifierLike> }).modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
            if (!isExp) continue;
            if (ts.isFunctionDeclaration(st) && st.name) exported.push({ name: st.name.text, line: lineOf(st) });
            else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && isFn(strip(d.initializer))) exported.push({ name: d.name.text, line: lineOf(d) });
        }
        const base = f.split('/').pop()!.replace(/\.tsx?$/, '');
        return exported.find((x) => x.name === 'Component') ?? exported.find((x) => x.name === base) ?? exported[0] ?? { name: 'Component', line: 1 };
    };
    const roots = [...rootFiles].sort().map((f): CandRoot => ({ file: f, kind: screenFiles.includes(f) ? 'screen' : 'app', main: mainExport(f), reach: [...reachOfRoot(f)].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([port, site]) => ({ port, site })) }));

    // the owners file: the backend objects each domain owns (planned for stubs; never edges)
    let owners: ReactClientAnalysis['owners'] = {};
    const ownSf = sfByRel.get(`${cfg.SRC}/${cfg.OWNERS_FILE}`);
    if (ownSf) for (const st of ownSf.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (d.name.getText() === 'OWNERS') owners = valueOf(d.initializer) ?? {};

    return { routes, routeIssues, ports: ports as unknown as CandPort[], seam: seam as unknown as CandSeam[], roots, owners, files: files.length };
}
