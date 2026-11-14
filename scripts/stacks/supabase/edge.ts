// What a Supabase project's Edge Functions do: one TypeScript program over supabase/functions, read with
// the compiler API. Pure analysis, no spec shapes: units (top-level functions and class methods) with their calls,
// table / RPC / bucket access, calls to outside systems through the typed ports, HTTP calls to other Edge Functions;
// routes of every `defineRouter`. The Supabase client comes from `jsr:`/`npm:` imports the compiler cannot type, so
// `.from()` / `.rpc()` / `.storage.from()` are matched by shape — and kept only when the argument folds to a name
// (a literal or a constant such as `databaseTables.job`). What does not fold is reported, never guessed.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { makeValues, supabaseCall } from './supabase-js.ts';
import type * as TS from 'typescript';
import type { Ts } from '../../../types/generator.ts';
import type { EdgeAnalysis, EdgeRoute, EdgeUnit, SupabaseConfig } from '../../../types/stacks/supabase.ts';

/** A declaration that may carry an initializer (a variable, a property). */
type WithInitializer = TS.Declaration & { initializer?: TS.Expression };

function listFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === '_test_' || name === 'node_modules' || name === 'fixtures') continue;
            listFiles(p, out);
        } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

/**
 * @param ts the typescript module
 * @param fnRoot absolute path of supabase/functions
 * @param config { EXCLUDE_DIRS, PORTS_DIR, KICK_HELPERS }
 */
export function analyzeEdgeFunctions(ts: Ts, fnRoot: string, config: SupabaseConfig['EDGE']): EdgeAnalysis {
    const rel = (p: string): string => relative(fnRoot, p).split(sep).join('/');
    const files = listFiles(fnRoot).filter((p) => !config.EXCLUDE_DIRS.some((d) => rel(p).startsWith(`${d}/`)));
    const program = ts.createProgram(files, {
        noEmit: true, allowImportingTsExtensions: true, allowJs: false, skipLibCheck: true, noResolve: false,
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    });
    const checker = program.getTypeChecker();
    const lineOf = (node: TS.Node): number => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const fileOf = (node: TS.Node): string => rel(node.getSourceFile().fileName);
    const short = (node: TS.Node, n = 140): string => node.getText().replace(/\s+/g, ' ').slice(0, n);

    // ---------- units ----------
    /** declaration node → unit */
    const unitOfDecl = new Map<TS.Node, EdgeUnit>();
    const units: EdgeUnit[] = [];
    const addUnit = (file: string, name: string, decl: TS.Node, body: TS.Node, className?: string): EdgeUnit => {
        const u: EdgeUnit = { key: `${file}#${name}`, file, name, className, line: lineOf(decl), body, calls: new Map(), tables: new Map(), rpcs: new Map(), buckets: new Map(), ports: new Map(), http: [], unresolved: [], auth: undefined, guards: new Set() };
        units.push(u);
        unitOfDecl.set(decl, u);
        return u;
    };
    for (const sf of program.getSourceFiles()) {
        if (!files.includes(sf.fileName)) continue;
        const file = rel(sf.fileName);
        const seen = new Set<string>();
        const uniq = (n: string): string => {
            let x = n;
            for (let i = 2; seen.has(x); i++) x = `${n}_${i}`;
            seen.add(x);
            return x;
        };
        for (const st of sf.statements) {
            if (ts.isFunctionDeclaration(st) && st.name && st.body) addUnit(file, uniq(st.name.text), st, st.body);
            else if (ts.isVariableStatement(st)) {
                for (const d of st.declarationList.declarations) {
                    let init = d.initializer;
                    while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init) || ts.isParenthesizedExpression(init))) init = init.expression;
                    if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                        const u = addUnit(file, uniq(d.name.text), d, init.body);
                        unitOfDecl.set(init, u);
                    }
                }
            } else if (ts.isClassDeclaration(st) && st.name) {
                for (const m of st.members) {
                    if ((ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) && m.body) {
                        const mname = ts.isConstructorDeclaration(m) ? 'constructor' : m.name.getText().replace(/^#/, '');
                        addUnit(file, uniq(`${st.name.text}_${mname}`), m, m.body, st.name.text);
                    } else if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) {
                        const u = addUnit(file, uniq(`${st.name.text}_${m.name.getText()}`), m, m.initializer.body, st.name.text);
                        unitOfDecl.set(m.initializer, u);
                    }
                }
            }
        }
    }

    // ---------- values: fold an expression to a literal when the code says what it is (supabase-js.ts) ----------
    const vals = makeValues(ts, checker);
    const { strip, valueOf, declOfCallee } = vals;

    // ---------- what each unit does ----------
    const isPort = (decl: TS.Node | undefined) => decl && fileOf(decl).startsWith(`${config.PORTS_DIR}/`);
    const portOf = (decl: TS.Node): string => fileOf(decl).slice(config.PORTS_DIR.length + 1).replace(/\.port\.ts$/, '');
    function visitUnit(u: EdgeUnit): void {
        const walk = (node: TS.Node): void => {
            // a nested unit's body is its own (class property arrows); nested closures belong to this unit
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) onCall(u, node);
            ts.forEachChild(node, walk);
        };
        walk(u.body);
    }
    function onCall(u: EdgeUnit, call: TS.CallExpression | TS.NewExpression): void {
        const callee = strip(call.expression);
        const args = call.arguments ?? [];
        const line = lineOf(call);
        const sb = supabaseCall(ts, vals, call);
        if (sb) {
            if (sb.kind === 'bucket') add(u.buckets, `${sb.bucket}|${sb.access}`, { bucket: sb.bucket, access: sb.access, op: sb.op, line });
            else if (sb.kind === 'table') add(u.tables, `${sb.schema}.${sb.table}|${sb.op}`, { schema: sb.schema, table: sb.table, op: sb.op, line });
            else if (sb.kind === 'rpc') add(u.rpcs, `${sb.schema}.${sb.fn}`, { schema: sb.schema, fn: sb.fn, line });
            else if (sb.kind === 'unresolved') u.unresolved.push({ kind: sb.code, line, expr: sb.expr });
            return;
        }
        const decl = declOfCallee(callee);
        const calleeName0 = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        // the access check a handler runs itself: `authenticate(req, { requireRBAC, allowedRoles, … })`, other checks
        if (calleeName0 === config.AUTH.options && args[1] && u.auth === undefined) u.auth = valueOf(args[1]) ?? {};
        else if (config.AUTH.options === calleeName0 && u.auth === undefined) u.auth = {};
        if (Object.hasOwn(config.AUTH.guards, calleeName0)) u.guards.add((config.AUTH.guards as Record<string, string>)[calleeName0]);
        // a typed port of an outside system (helpers/external/ports)
        if (decl && isPort(decl) && (ts.isMethodSignature(decl) || ts.isPropertySignature(decl))) {
            const k = `${portOf(decl)}|${decl.name.getText()}`;
            add(u.ports, k, { port: portOf(decl), method: decl.name.getText(), line });
            if (Object.hasOwn(config.AUTH.portGuards, k)) u.guards.add((config.AUTH.portGuards as Record<string, string>)[k]);
            return;
        }
        // a call of another unit
        const init = (decl as WithInitializer | undefined)?.initializer;
        const target = decl && (unitOfDecl.get(decl) ?? (init && unitOfDecl.get(strip(init))));
        if (target && target !== u) {
            add(u.calls, target.key, { target, line });
        }
        // HTTP to another Edge Function: fetch(url) and the kick helpers
        const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        const kick = Object.hasOwn(config.KICK_HELPERS, calleeName) ? (config.KICK_HELPERS as Record<string, { pathArg: number; prefix: string }>)[calleeName] : undefined;
        if (kick && decl && !target?.file.startsWith('_')) {
            const p = valueOf(args[kick.pathArg]);
            u.http.push({ line, url: typeof p === 'string' ? `/functions/v1${kick.prefix}${p}` : null, method: 'POST', expr: short(call) });
        } else if (calleeName === 'fetch' && ts.isIdentifier(callee) && args.length && !Object.hasOwn(config.KICK_HELPERS, u.name)) {
            const url = valueOf(args[0]);
            const opts = valueOf(args[1]);
            u.http.push({ line, url: typeof url === 'string' ? url : null, method: typeof (opts as { method?: unknown } | undefined)?.method === 'string' ? (opts as { method: string }).method.toUpperCase() : undefined, expr: short(call) });
        }
    }
    const add = <V>(map: Map<string, V>, k: string, v: V): void => {
        if (!map.has(k)) map.set(k, v);
    };
    for (const u of units) visitUnit(u);

    // ---------- routes ----------
    /** the unit an expression names: `fn`, `obj.fn`, or a wrapper call `withCronMonitor('', fn)` (its unit argument) */
    function unitOfExpr(expr: TS.Expression | undefined, depth = 0): EdgeUnit | undefined {
        const e = strip(expr);
        if (!e || depth > 3) return undefined;
        if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
            const d = declOfCallee(e);
            const init = (d as WithInitializer | undefined)?.initializer;
            return d && (unitOfDecl.get(d) ?? (init && unitOfDecl.get(strip(init))));
        }
        if (ts.isCallExpression(e)) for (const a of [...e.arguments].reverse()) {
            const u = unitOfExpr(a, depth + 1);
            if (u) return u;
        }
        if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
            // an inline handler `(ctx) => fn(ctx)`: the one unit it calls
            let found: EdgeUnit | undefined;
            const walk = (n: TS.Node): void => {
                if (!found && ts.isCallExpression(n)) found = unitOfExpr(n.expression, depth + 1);
                if (!found) ts.forEachChild(n, walk);
            };
            walk(e.body);
            return found;
        }
        return undefined;
    }
    /** route definitions of `routes: [...]`, following identifiers and spreads to their arrays */
    function routeElements(expr: TS.Expression | undefined, depth = 0): TS.Expression[] {
        const e = strip(expr);
        if (!e || depth > 4) return [];
        if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((x) => (ts.isSpreadElement(x) ? routeElements(x.expression, depth + 1) : [x]));
        if (ts.isIdentifier(e)) {
            const d = declOfCallee(e);
            const init = (d as WithInitializer | undefined)?.initializer;
            return init ? routeElements(init, depth + 1) : [];
        }
        if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['concat'].includes(e.expression.name.text))
            return [...routeElements(e.expression.expression, depth + 1), ...e.arguments.flatMap((a) => routeElements(a, depth + 1))];
        return [];
    }
    const routes: EdgeRoute[] = [];
    const routeIssues: EdgeAnalysis['routeIssues'] = [];
    for (const sf of program.getSourceFiles()) {
        const file = rel(sf.fileName);
        if (!files.includes(sf.fileName) || !/^[^/]+\/index\.ts$/.test(file)) continue;
        const fn = file.split('/')[0];
        const visit = (node: TS.Node): void => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineRouter' && node.arguments[0]) {
                const rArg = strip(node.arguments[0]);
                const props = new Map(ts.isObjectLiteralExpression(rArg) ? rArg.properties.filter(ts.isPropertyAssignment).map((p): [string, TS.Expression] => [p.name.getText(), p.initializer]) : []);
                const basePath = valueOf(props.get('basePath')) ?? '';
                for (const el of routeElements(props.get('routes'))) {
                    let call: TS.Expression | undefined = strip(el);
                    if (call && ts.isIdentifier(call)) call = strip((declOfCallee(call) as WithInitializer | undefined)?.initializer); // `const preflightRoute = defineRoute({…})`
                    const def = call && ts.isCallExpression(call) ? strip(call.arguments[0]) : null;
                    if (!def || !ts.isObjectLiteralExpression(def)) {
                        routeIssues.push({ kind: 'route', file, line: lineOf(el), expr: short(el) });
                        continue;
                    }
                    const p = new Map(def.properties.filter((x) => ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)).map((x): [string, TS.Expression] => [x.name!.getText(), ts.isPropertyAssignment(x) ? x.initializer : (x as TS.ShorthandPropertyAssignment).name]));
                    const handlerExpr = strip(p.get('handler'));
                    const handler = unitOfExpr(handlerExpr);
                    const reqSchema = strip(p.get('requestSchema'));
                    const bodyExpr = reqSchema && ts.isObjectLiteralExpression(reqSchema) ? reqSchema.properties.find((x) => x.name?.getText() === 'body') : undefined;
                    const ident = (x: TS.Expression | undefined): string | undefined => (x && ts.isIdentifier(strip(x)) ? (strip(x) as TS.Identifier).text : undefined);
                    routes.push({
                        fn, file, line: lineOf(def), basePath,
                        method: String(valueOf(p.get('method')) ?? '').toUpperCase(),
                        path: valueOf(p.get('path')),
                        summary: valueOf(p.get('summary')),
                        authRequired: valueOf(p.get('authRequired')),
                        disableAuthentication: valueOf(p.get('disableAuthentication')),
                        authentication: valueOf(p.get('authentication')),
                        security: valueOf(p.get('security')),
                        requestDto: ident(bodyExpr && ((bodyExpr as { initializer?: TS.Expression }).initializer ?? (bodyExpr.name as TS.Expression | undefined))),
                        responseDto: ident(p.get('responseSchema')),
                        handler, handlerText: handlerExpr ? short(handlerExpr, 60) : undefined,
                    });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return { units, routes, routeIssues, files: files.map(rel) };
}
