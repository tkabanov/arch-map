// Reads the backend sources with the TypeScript compiler API: Nest modules, their providers and controllers,
// constructor DI, Sequelize models, routes and the method calls between classes.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';
import type { Ts } from '../../../types/generator.ts';
import type { BackendDep, BackendScan, ClassInfo, ClassKind, MethodFacts, ModuleRef, NestModule } from '../../../types/stacks/nest.ts';

const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);

export function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, accept, out);
        else if (accept(full)) out.push(full);
    }
    return out;
}

export function loadTs(appDir: string): Ts {
    return createRequire(join(appDir, 'package.json'))('typescript');
}

/** Resolves a relative import to a .ts file. */
export function resolveImport(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(fromFile), spec);
    for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
}

/** The compiler-API helpers every pass shares (they close over the `ts` module only). */
interface Ast {
    decoratorsOf: (node: TS.Node) => readonly TS.Decorator[];
    decoName: (d: TS.Decorator) => string;
    decoArgs: (d: TS.Decorator) => readonly TS.Expression[];
    stringArg: (args: readonly TS.Expression[]) => string;
    jsdoc: (node: TS.Node, sf: TS.SourceFile) => string;
    authOf: (names: string[], decos: readonly TS.Decorator[]) => string | null;
    classInFile: (sf: TS.SourceFile, name: string) => boolean;
}

/** One source file being read: what every per-class pass needs. */
interface FileCtx {
    ts: Ts;
    ast: Ast;
    backendDir: string;
    file: string;
    sf: TS.SourceFile;
    imports: Map<string, string>; // local name → file
}

function makeAst(ts: Ts): Ast {
    // `node.decorators`: the compiler API before TS 4.8 (the target's own typescript may be old)
    const decoratorsOf = (node: TS.Node): readonly TS.Decorator[] => (ts.canHaveDecorators?.(node) ? ts.getDecorators(node) ?? [] : (node as { decorators?: readonly TS.Decorator[] }).decorators ?? []);
    const decoName = (d: TS.Decorator): string => {
        const e = d.expression;
        if (ts.isCallExpression(e)) return ts.isIdentifier(e.expression) ? e.expression.text : e.expression.getText();
        return e.getText();
    };
    const decoArgs = (d: TS.Decorator): readonly TS.Expression[] => (ts.isCallExpression(d.expression) ? d.expression.arguments : []);
    const stringArg = (args: readonly TS.Expression[]): string => {
        const a = args[0];
        if (!a) return '';
        if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text;
        if (ts.isArrayLiteralExpression(a) && a.elements[0] && ts.isStringLiteral(a.elements[0])) return a.elements[0].text;
        if (ts.isObjectLiteralExpression(a)) {
            const p = a.properties.find((x) => x.name?.getText() === 'path');
            if (p && ts.isStringLiteral((p as TS.PropertyAssignment).initializer)) return ((p as TS.PropertyAssignment).initializer as TS.StringLiteral).text;
        }
        return '';
    };
    const jsdoc = (node: TS.Node, sf: TS.SourceFile): string => {
        const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
        const doc = ranges.map((r) => sf.text.slice(r.pos, r.end)).filter((t) => t.startsWith('/**')).pop();
        if (!doc) return '';
        return doc
            .replace(/^\/\*\*|\*\/$/g, '')
            .split('\n')
            .map((l) => l.replace(/^\s*\* ?/, ''))
            .filter((l) => !l.startsWith('@'))
            .join('\n')
            .trim();
    };
    function authOf(names: string[], decos: readonly TS.Decorator[]): string | null {
        if (names.includes('Public')) return 'public';
        const can = names.indexOf('Can');
        if (can >= 0) {
            const a = (decos[can].expression as TS.CallExpression).arguments?.map((x) => x.getText().replace(/['"]/g, '')).join(', ');
            return `can: ${a}`;
        }
        if (names.includes('Authenticated')) return 'jwt';
        return null;
    }
    function classInFile(sf: TS.SourceFile, name: string): boolean {
        return sf.statements.some((s) => ts.isClassDeclaration(s) && s.name?.text === name);
    }
    return { decoratorsOf, decoName, decoArgs, stringArg, jsdoc, authOf, classInFile };
}

const lineAt = (fc: FileCtx, node: TS.Node): number => fc.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

// ---------- pass 1: a file's imports and top-level string constants ----------

function readImports(fc: FileCtx): void {
    const { ts, file, sf, imports } = fc;
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !st.importClause) continue;
        const specifier = (st.moduleSpecifier as TS.StringLiteral).text;
        const target = resolveImport(file, specifier);
        const named = st.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) for (const el of named.elements) imports.set(el.name.text, target ?? `pkg:${specifier}`);
    }
}

function readConstants(fc: FileCtx, constants: Map<string, string>): void {
    const { ts, file, sf } = fc;
    for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations)
            if (d.initializer && ts.isStringLiteral(d.initializer)) constants.set(`${file}#${d.name.getText()}`, d.initializer.text);
    }
}

// ---------- pass 2: one class — header, class-level decorators ----------

function classKindOf(names: string[]): ClassKind {
    return names.includes('Module')
        ? 'module'
        : names.includes('Controller')
          ? 'controller'
          : names.includes('Table')
            ? 'model'
            : names.includes('WebSocketGateway')
              ? 'gateway'
              : names.includes('Injectable')
                ? 'injectable'
                : 'class';
}

function newClassInfo(fc: FileCtx, st: TS.ClassDeclaration & { name: TS.Identifier }, names: string[]): ClassInfo {
    const { file, sf, imports, backendDir, ast } = fc;
    return {
        name: st.name.text,
        file,
        rel: relative(backendDir, file),
        line: sf.getLineAndCharacterOfPosition(st.getStart()).line + 1,
        doc: ast.jsdoc(st, sf),
        kind: classKindOf(names),
        imports,
        deps: [], // { param, typeName, typeFile, line, model?, token? }
        calls: new Map(), // param → Set(method)
        staticCalls: new Map(), // imported name → Set(method)
        published: [], // domain events: { name, file } of `publish(new X())`
        // name → { calls:[{param,method,line}], model:[{method,line}], statics:[{name,method,line}],
        //          publishes:[{name,file,line}], self:[{method,line}], unresolved:[{expr,line}] }
        // (an entry exists only for members that call something)
        methods: new Map(),
        memberLines: new Map(), // every method / function-valued property / accessor → its declaration line
        routes: [],
        eventHandlers: [], // { decorator, method }
        module: null,
        columns: [],
        fks: [],
        tableName: null,
        baseModel: null, // ABaseRepository<Model>: the model this repository wraps
        base: null, // { name, file } of the extended class, when there is one
        modelCalls: new Set(), // this.model.<method>(…)
    };
}

function readHeritage(fc: FileCtx, st: TS.ClassDeclaration, info: ClassInfo): void {
    const { ts, file, sf, imports, ast } = fc;
    for (const h of st.heritageClauses ?? []) {
        for (const t of h.types) {
            if (h.token === ts.SyntaxKind.ExtendsKeyword && ts.isIdentifier(t.expression)) {
                const n = t.expression.text;
                info.base = { name: n, file: imports.get(n) ?? (ast.classInFile(sf, n) ? file : null) };
            }
            const arg = t.typeArguments?.[0];
            if (/Repository$/.test(t.expression.getText()) && arg && ts.isTypeReferenceNode(arg)) {
                const n = arg.typeName.getText();
                info.baseModel = { name: n, file: imports.get(n) ?? file };
            }
        }
    }
}

/** `@Module({ imports, providers, controllers, exports })` → `info.module`. */
function readModuleDecorator(fc: FileCtx, info: ClassInfo, decos: readonly TS.Decorator[], names: string[]): void {
    const { ts, ast } = fc;
    const arg = ast.decoArgs(decos[names.indexOf('Module')])[0];
    info.module = { imports: [], providers: [], controllers: [], exports: [], models: [] };
    const lists = info.module as unknown as Record<string, ModuleRef[] | undefined>;
    if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
            const key = p.name?.getText();
            if (key === undefined || !lists[key] || !ts.isPropertyAssignment(p) || !ts.isArrayLiteralExpression(p.initializer)) continue;
            for (const el of p.initializer.elements) collectModuleRef(fc, el, key, info.module);
        }
    }
}

function collectModuleRef(fc: FileCtx, el: TS.Expression, key: string, mod: NestModule): void {
    const { ts, file, sf, imports, ast } = fc;
    const lists = mod as unknown as Record<string, ModuleRef[]>;
    if (ts.isIdentifier(el)) {
        lists[key].push({ name: el.text, file: imports.get(el.text) ?? (ast.classInFile(sf, el.text) ? file : null) });
        return;
    }
    if (ts.isCallExpression(el)) {
        const callee = el.expression.getText();
        if (callee === 'forwardRef') {
            const fn = el.arguments[0];
            if (fn && ts.isArrowFunction(fn) && ts.isIdentifier(fn.body)) collectModuleRef(fc, fn.body, key, mod);
            return;
        }
        if (callee === 'SequelizeModule.forFeature') {
            const arr = el.arguments[0];
            if (arr && ts.isArrayLiteralExpression(arr))
                for (const m of arr.elements) if (ts.isIdentifier(m)) mod.models.push({ name: m.text, file: imports.get(m.text) ?? file });
            return;
        }
        if (ts.isPropertyAccessExpression(el.expression) && ts.isIdentifier(el.expression.expression)) {
            const n = el.expression.expression.text;
            lists[key].push({ name: n, file: imports.get(n) ?? null, dynamic: el.expression.name.text });
        }
        return;
    }
    if (ts.isObjectLiteralExpression(el)) {
        const useClass = el.properties.find((p) => (['useClass', 'useExisting'] as (string | undefined)[]).includes(p.name?.getText()));
        if (useClass && ts.isPropertyAssignment(useClass) && ts.isIdentifier(useClass.initializer)) {
            const n = useClass.initializer.text;
            lists[key].push({ name: n, file: imports.get(n) ?? null });
        }
    }
}

/** `@Table({ tableName })` → `info.tableName` (the class name when there is none). */
function readTableName(fc: FileCtx, info: ClassInfo, decos: readonly TS.Decorator[], names: string[]): void {
    const { ts, ast } = fc;
    const arg = ast.decoArgs(decos[names.indexOf('Table')])[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
        const p = arg.properties.find((x) => x.name?.getText() === 'tableName');
        if (p && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) info.tableName = p.initializer.text;
    }
    info.tableName ??= info.name;
}

// ---------- pass 3: the members — constructor DI, routes, event handlers, columns, relations ----------

function readConstructor(fc: FileCtx, member: TS.ConstructorDeclaration, info: ClassInfo): void {
    const { ts, file, sf, imports, ast } = fc;
    for (const param of member.parameters) {
        const pname = param.name.getText();
        const typeName = param.type && ts.isTypeReferenceNode(param.type) ? param.type.typeName.getText().split('.').pop()! : null;
        const dep: BackendDep = { param: pname, typeName, typeFile: typeName ? imports.get(typeName) ?? (ast.classInFile(sf, typeName) ? file : null) : null, line: lineAt(fc, param) };
        for (const d of ast.decoratorsOf(param)) {
            const dn = ast.decoName(d);
            const a = ast.decoArgs(d)[0];
            if (dn === 'InjectModel' && a && ts.isIdentifier(a)) {
                dep.model = a.text;
                dep.modelFile = imports.get(a.text) ?? file;
            }
            if (dn === 'Inject' && a) dep.token = a.getText();
        }
        info.deps.push(dep);
    }
}

/** A controller method with an HTTP decorator → `info.routes`. */
function readRoute(fc: FileCtx, member: TS.MethodDeclaration | TS.PropertyDeclaration, info: ClassInfo, m: MemberDecos, cls: ClassDecos, http: string): void {
    const { ts, sf, ast } = fc;
    const { mdecos, mnames, mname } = m;
    const sub = ast.stringArg(ast.decoArgs(mdecos[mnames.indexOf(http)])).replace(/^\/|\/$/g, '');
    const path = [info.prefix, sub].filter(Boolean).join('/');
    const body = ts.isMethodDeclaration(member)
        ? member.parameters.find((p) => ast.decoratorsOf(p).some((d) => ast.decoName(d) === 'Body'))
        : null;
    info.routes.push({
        method: http.toUpperCase(),
        path,
        handler: mname,
        operationId: `${info.name}_${mname}`,
        auth: ast.authOf(mnames, mdecos) ?? cls.auth ?? 'jwt',
        system: mnames.includes('SystemApi') || cls.names.includes('SystemApi'),
        body: body?.type ? body.type.getText() : null,
        doc: ast.jsdoc(member, sf),
        line: sf.getLineAndCharacterOfPosition(member.getStart()).line + 1,
    });
}

function readEventHandlers(fc: FileCtx, info: ClassInfo, m: MemberDecos): void {
    const { ts, file, imports, ast } = fc;
    const { mdecos, mnames, mname } = m;
    mnames.forEach((n, i) => {
        if (!n.startsWith('On') || n === 'OnEvent') return;
        const arg = ast.decoArgs(mdecos[i])[0];
        const argName = arg && ts.isIdentifier(arg) ? arg.text : null;
        info.eventHandlers.push({ decorator: n, method: mname, argName, argFile: argName ? imports.get(argName) ?? file : null, line: lineAt(fc, mdecos[i]) });
    });
}

/** `@Column(…)` on a model property → `info.columns`. */
function readColumn(fc: FileCtx, info: ClassInfo, m: MemberDecos): void {
    const { ts, ast } = fc;
    const { mdecos, mnames, mname } = m;
    const a = ast.decoArgs(mdecos[mnames.indexOf('Column')])[0];
    let type = '';
    let nullable = false;
    let pk = false;
    if (a && ts.isObjectLiteralExpression(a)) {
        for (const p of a.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const k = p.name.getText();
            if (k === 'type') type = p.initializer.getText().replace(/^DataType\./, '');
            if (k === 'allowNull') nullable = p.initializer.getText() === 'true';
            if (k === 'primaryKey') pk = p.initializer.getText() === 'true';
        }
    } else if (a) type = a.getText().replace(/^DataType\./, '');
    info.columns.push({ name: mname, type, nullable, pk });
}

/** `@ForeignKey` / `@BelongsTo` / … on a model property → `info.fks`. */
function readRelations(fc: FileCtx, info: ClassInfo, m: MemberDecos): void {
    const { file, imports, ast } = fc;
    const { mdecos, mnames, mname } = m;
    for (const rel of ['ForeignKey', 'BelongsTo', 'HasMany', 'HasOne', 'BelongsToMany']) {
        if (!mnames.includes(rel)) continue;
        const args = ast.decoArgs(mdecos[mnames.indexOf(rel)]);
        const target = args[0]?.getText().replace(/^\(\)\s*=>\s*/, '');
        const through = rel === 'BelongsToMany' ? args[1]?.getText().replace(/^\(\)\s*=>\s*/, '') : null;
        if (target) info.fks.push({ rel, field: mname, target, targetFile: imports.get(target) ?? file, through, line: lineAt(fc, mdecos[mnames.indexOf(rel)]) });
    }
}

/** A class's decorator names and its own auth, which a route falls back to. */
interface ClassDecos {
    names: string[];
    auth: string | null;
}

/** A method / property with its decorators and their names. */
interface MemberDecos {
    mdecos: readonly TS.Decorator[];
    mnames: string[];
    mname: string;
}

function readMember(fc: FileCtx, member: TS.MethodDeclaration | TS.PropertyDeclaration, info: ClassInfo, cls: ClassDecos): void {
    const { ts, ast } = fc;
    const mdecos = ast.decoratorsOf(member);
    const mnames = mdecos.map(ast.decoName);
    const mname = member.name.getText();
    const m: MemberDecos = { mdecos, mnames, mname };
    if (ts.isMethodDeclaration(member) || (member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))))
        info.memberLines.set(mname, lineAt(fc, member));
    const http = mnames.find((n) => HTTP_DECORATORS.has(n));
    if (http && info.kind === 'controller') readRoute(fc, member, info, m, cls, http);
    readEventHandlers(fc, info, m);
    if (info.kind === 'model' && ts.isPropertyDeclaration(member)) {
        if (mnames.includes('Column')) readColumn(fc, info, m);
        readRelations(fc, info, m);
    }
}

// ---------- pass 4: this.<param>.<method>( … ) calls inside the class ----------

/** The state of the call walk over one class. */
interface Tracer {
    fc: FileCtx;
    info: ClassInfo;
    paramNames: Set<string>;
}

// per method: what it calls, so a path can be traced from an endpoint down to tables
function methodOf(info: ClassInfo, m: string): MethodFacts {
    if (!info.methods.has(m)) info.methods.set(m, { calls: [], model: [], statics: [], publishes: [], self: [], unresolved: [] });
    return info.methods.get(m)!;
}

const pushUnique = <T>(arr: T[], item: T): void => { if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(item))) arr.push(item); };

/** A `this.<param>.<method>(…)` call found by the walk. */
interface ParamCall {
    node: TS.CallExpression;
    callee: TS.PropertyAccessExpression;
    target: TS.PropertyAccessExpression;
    cur: string | null;
    line: number;
}

/** `this.<param>.<method>(…)` — and `this.domainEvents.publish(new X())` on it. */
function traceParamCall(tr: Tracer, call: ParamCall): void {
    const { ts, file, imports } = tr.fc;
    const { info } = tr;
    const { node, callee, target, cur, line } = call;
    const set = info.calls.get(target.name.text) ?? new Set<string>();
    set.add(callee.name.text);
    info.calls.set(target.name.text, set);
    if (cur) pushUnique(methodOf(info, cur).calls, { param: target.name.text, method: callee.name.text, line });
    // this.domainEvents.publish(new SomeEvent(…))
    const first = node.arguments[0];
    if (callee.name.text === 'publish' && first && ts.isNewExpression(first) && ts.isIdentifier(first.expression)) {
        const n = first.expression.text;
        info.published.push({ name: n, file: imports.get(n) ?? file, line });
        if (cur) pushUnique(methodOf(info, cur).publishes, { name: n, file: imports.get(n) ?? file, line });
    }
}

const isThis = (ts: Ts, n: TS.Node): boolean => n.kind === ts.SyntaxKind.ThisKeyword;

function traceMemberCall(tr: Tracer, node: TS.CallExpression, callee: TS.PropertyAccessExpression, cur: string | null): void {
    const { ts, imports } = tr.fc;
    const { info, paramNames } = tr;
    let target: TS.Expression = callee.expression;
    const line = lineAt(tr.fc, node);
    // Model.unscoped().findAll(…) / Model.scope(…).findAll(…): the call is on the model
    if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && ['unscoped', 'scope'].includes(target.expression.name.text) && ts.isIdentifier(target.expression.expression))
        target = target.expression.expression;
    // this.ownMethod(…): followed when tracing
    if (isThis(ts, target) && cur) pushUnique(methodOf(info, cur).self, { method: callee.name.text, line });
    if (ts.isPropertyAccessExpression(target) && isThis(ts, target.expression) && paramNames.has(target.name.text)) traceParamCall(tr, { node, callee, target, cur, line });
    if (ts.isPropertyAccessExpression(target) && isThis(ts, target.expression) && target.name.text === 'model') {
        info.modelCalls.add(callee.name.text);
        if (cur) pushUnique(methodOf(info, cur).model, { method: callee.name.text, line });
    }
    // Model.findAll(…): static calls on an imported class (Sequelize models are used this way a lot)
    if (ts.isIdentifier(target) && imports.has(target.text) && !['unscoped', 'scope'].includes(callee.name.text)) {
        const set = info.staticCalls.get(target.text) ?? new Set<string>();
        set.add(callee.name.text);
        info.staticCalls.set(target.text, set);
        if (cur) pushUnique(methodOf(info, cur).statics, { name: target.text, method: callee.name.text, line });
    }
}

function visitCalls(tr: Tracer, node: TS.Node, cur: string | null): void {
    const { ts } = tr.fc;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) traceMemberCall(tr, node, node.expression, cur);
    // this[name](…) / this.dep[name](…): the callee is computed at run time — a break in the Path
    if (cur && ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)) {
        const obj = node.expression.expression;
        if (isThis(ts, obj) || (ts.isPropertyAccessExpression(obj) && isThis(ts, obj.expression)))
            pushUnique(methodOf(tr.info, cur).unresolved, { expr: node.expression.getText().replace(/\s+/g, ' ').slice(0, 120), line: lineAt(tr.fc, node) });
    }
    ts.forEachChild(node, (c) => visitCalls(tr, c, cur));
}

// ---------- the scan ----------

/** One class: header, class-level decorators, members, then the calls. */
function readClass(fc: FileCtx, st: TS.ClassDeclaration & { name: TS.Identifier }): ClassInfo {
    const { ts, ast } = fc;
    const decos = ast.decoratorsOf(st);
    const names = decos.map(ast.decoName);
    const info = newClassInfo(fc, st, names);
    readHeritage(fc, st, info);
    const classAuth = ast.authOf(names, decos);

    if (info.kind === 'module') readModuleDecorator(fc, info, decos, names);
    if (info.kind === 'controller') info.prefix = ast.stringArg(ast.decoArgs(decos[names.indexOf('Controller')])).replace(/^\/|\/$/g, '');
    if (info.kind === 'model') readTableName(fc, info, decos, names);

    for (const member of st.members) {
        if (ts.isConstructorDeclaration(member)) readConstructor(fc, member, info);
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && member.name) readMember(fc, member, info, { names, auth: classAuth });
    }
    // this.<param>.<method>( … ) calls inside the class
    const tr: Tracer = { fc, info, paramNames: new Set(info.deps.map((d) => d.param)) };
    for (const member of st.members) visitCalls(tr, member, member.name && !ts.isConstructorDeclaration(member) ? member.name.getText() : null);
    return info;
}

export function scanBackend(ts: Ts, backendDir: string): BackendScan {
    const srcDir = join(backendDir, 'src');
    const files = walk(srcDir, (f) => f.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(f) && !/\/tests?\//.test(f));
    const classes = new Map<string, ClassInfo>(); // key `${file}#${name}` → info
    const byName = new Map<string, ClassInfo[]>(); // name → [info]
    const constants = new Map<string, string>(); // `${file}#NAME` → string value
    const ast = makeAst(ts);

    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const fc: FileCtx = { ts, ast, backendDir, file, sf, imports: new Map() };
        readImports(fc);
        readConstants(fc, constants);
        for (const st of sf.statements) {
            if (!ts.isClassDeclaration(st) || !st.name) continue;
            const info = readClass(fc, st as TS.ClassDeclaration & { name: TS.Identifier });
            classes.set(`${file}#${info.name}`, info);
            if (!byName.has(info.name)) byName.set(info.name, []);
            byName.get(info.name)!.push(info);
        }
    }

    const find = (name: string, file?: string | null): ClassInfo | null => (file && classes.get(`${file}#${name}`)) || (byName.get(name)?.length === 1 ? byName.get(name)![0] : null);
    return { classes, byName, find, srcDir, constants };
}
