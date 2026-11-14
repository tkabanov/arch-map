// Finds API calls in a frontend: string and template literals that look like a backend route, the HTTP method
// from a `method: '…'` next to them, and which files import the calling file.
import { readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { walk } from './backend.ts';
import type * as TS from 'typescript';
import type { Ts } from '../../../types/generator.ts';
import type { FrontendCall, FrontendScan, FrontendScanConfig } from '../../../types/stacks/nest.ts';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** The script blocks of an SFC, with everything else blanked out line by line, so positions stay file positions. */
const scriptOf = (file: string, text: string): string => {
    if (!file.endsWith('.vue')) return text;
    const blank = (t: string) => t.replace(/[^\n]/g, ' ');
    let out = '';
    let at = 0;
    for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/g)) {
        const start = m.index! + m[1].length;
        out += blank(text.slice(at, start)) + m[2];
        at = start + m[2].length;
    }
    return out + blank(text.slice(at));
};

/** `orders/${id}/refund?x=${q}` → `orders/:p/refund` */
export function normalizePath(raw: string): string {
    let p = raw.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    p = p
        .split('/')
        // eslint-disable-next-line no-control-regex -- \u0000 is the placeholder scanFrontend puts where a template had `${…}`
        .map((seg) => (seg === '\u0000' ? ':p' : seg.replace(/\u0000/g, '')))
        .filter((seg, i, all) => seg !== '' || i < all.length - 1)
        .join('/');
    return p;
}

export function scanFrontend(ts: Ts, fe: FrontendScanConfig, appDir: string): FrontendScan {
    const all = fe.roots.flatMap((r) =>
        existsSync(join(appDir, r))
            ? walk(join(appDir, r), (f) => /\.(ts|vue)$/.test(f) && !/\.(test|spec|d)\.ts$/.test(f) && !/mock/i.test(f) && !/\/tests?\//.test(f))
            : [],
    );
    const calls: FrontendCall[] = []; // { file, rel, line, method, path, raw }
    const importers = new Map<string, Set<string>>(); // rel → Set(rel of importer)
    const importLines = new Map<string, number>(); // `${importer rel}|${imported rel}` → line of the first import statement

    for (const file of all) {
        const rel = relative(appDir, file);
        const text = scriptOf(file, readFileSync(file, 'utf8'));
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

        for (const st of sf.statements) {
            if (!ts.isImportDeclaration(st)) continue;
            const target = resolveFe(file, (st.moduleSpecifier as TS.StringLiteral).text, appDir, fe);
            if (!target) continue;
            const trel = relative(appDir, target);
            if (!importers.has(trel)) importers.set(trel, new Set());
            importers.get(trel)!.add(rel);
            const key = `${rel}|${trel}`;
            if (!importLines.has(key)) importLines.set(key, sf.getLineAndCharacterOfPosition(st.getStart()).line + 1);
        }

        const visit = (node: TS.Node): void => {
            let raw: string | null = null;
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) raw = node.text;
            else if (ts.isTemplateExpression(node)) raw = node.head.text + node.templateSpans.map((s) => '\u0000' + s.literal.text).join('');
            // eslint-disable-next-line no-control-regex -- \u0000 marks a template's `${…}` (see normalizePath)
            if (raw !== null && /^\/?[a-z][a-z0-9-]*(\/|$|\?|\u0000)/.test(raw) && !raw.includes(' ') && raw.length < 200 && looksLikeRequest(node)) {
                // the template may glue a placeholder to a segment (`requests${query}`): keep only whole-segment ones
                const callee = ts.isCallExpression(node.parent) ? node.parent.expression.getText().split('.').pop()! : '';
                if (fe.prefixCalls?.[callee]) raw += fe.prefixCalls[callee];
                // eslint-disable-next-line no-control-regex -- \u0000 marks a template's `${…}` (see normalizePath)
                const fixed = raw.replace(/([^/])\u0000/g, '$1').replace(/\u0000([^/])/g, '$1');
                calls.push({
                    file,
                    rel,
                    line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                    method: methodNear(node),
                    path: normalizePath(fixed),
                    raw,
                });
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }

    /** The literal is the first argument of a call (`http('x')`, `client.get('x', …)`) or the value of a `path`/`url` variable. */
    function looksLikeRequest(node: TS.Node): boolean {
        const p = node.parent;
        if (p && ts.isCallExpression(p) && p.arguments[0] === node) return true;
        if (p && ts.isVariableDeclaration(p) && p.initializer === node && /path|url|endpoint/i.test(p.name.getText())) return true;
        // returned by a path builder: `const promocodePath = (…) => \`start/${id}/promocode\``
        if (p && (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === node))) {
            let fn: TS.Node | undefined = p;
            while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
            const name = (fn as TS.SignatureDeclaration | undefined)?.name?.getText() ?? (fn?.parent && ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText() : '');
            return /path|url|endpoint/i.test(name);
        }
        return false;
    }

    function methodNear(node: TS.Node): string | null {
        let call: TS.Node | undefined = node.parent;
        while (call && !ts.isCallExpression(call)) {
            if (ts.isBlock(call) || ts.isSourceFile(call)) return null;
            call = call.parent;
        }
        if (!call) return null;
        for (const arg of call.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            const m = arg.properties.find((p) => p.name?.getText() === 'method');
            if (m && ts.isPropertyAssignment(m) && (ts.isStringLiteral(m.initializer) || ts.isNoSubstitutionTemplateLiteral(m.initializer))) {
                const v = m.initializer.text.toUpperCase();
                if (METHODS.has(v)) return v;
            }
        }
        const callee = call.expression.getText();
        const last = callee.split('.').pop()!.toUpperCase();
        if (METHODS.has(last)) return last; // client.get(…), client.post(…)
        return null;
    }

    return { calls, importers, importLines };
}

function resolveFe(fromFile: string, spec: string, appDir: string, fe: FrontendScanConfig): string | null {
    let base: string;
    if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
    else if (spec.startsWith('#shared/')) base = join(appDir, 'shared', spec.slice(8));
    else if (spec.startsWith('~/') || spec.startsWith('@/')) base = join(appDir, fe.id === 'web' ? 'app' : 'src', spec.slice(2));
    else return null;
    for (const c of [base, `${base}.ts`, `${base}.vue`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
}

/** Best backend route for a frontend path: same segment count, literals equal, a backend `:param` takes anything. */
export function matchRoute<R extends { path: string; method: string }>(routes: R[], call: { path: string; method: string | null }): R | null {
    const segs = call.path.split('/');
    let best: { route: R; score: number } | null = null;
    for (const r of routes) {
        const rs = r.path.split('/');
        if (rs.length !== segs.length) continue;
        let score = 0;
        let ok = true;
        for (let i = 0; i < rs.length; i++) {
            if (rs[i].startsWith(':')) continue;
            if (rs[i] === segs[i]) score += 2;
            else {
                ok = false;
                break;
            }
        }
        if (!ok || score === 0) continue;
        if (call.method && r.method === call.method) score += 1;
        else if (call.method && r.method !== call.method) continue;
        else if (!call.method && r.method === 'GET') score += 0.5;
        if (!best || score > best.score) best = { route: r, score };
    }
    return best?.route ?? null;
}
