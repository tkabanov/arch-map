// What a Postgres function body, a cron command or a view touches. Pure: text in, facts out.
// SQL is parsed by the real Postgres parser (libpg_query, WASM); PL/pgSQL bodies by its PL/pgSQL parser, and each
// SQL statement inside them by the SQL parser. Nothing is guessed: what cannot be parsed or resolved is returned in
// `unresolved` with the reason, never as a fact.
import { loadModule, parseSync, parsePlPgSQLSync } from 'libpg-query';
import type { Facts, PgNode, PgRangeVar, QName, SnapFunction } from '../../../types/stacks/supabase.ts';

let ready: Promise<void> | null = null;
/** The WASM module loads once; call before any analysis. */
export const loadParser = () => (ready ??= loadModule());

const newFacts = (): Facts => ({ reads: new Map(), writes: new Map(), calls: new Map(), http: [], unresolved: [], temp: new Set() });
const key = (q: QName): string => `${q.schema ?? ''}.${q.name}`;
const add = (map: Facts['reads'], q: QName, op: string): void => {
    const k = key(q);
    if (!map.has(k)) map.set(k, { q, ops: new Set() });
    if (op) map.get(k)!.ops.add(op);
};

/** Functions that send HTTP from the database (pg_net, database webhooks). */
const HTTP_FUNCS = new Set(['net.http_post', 'net.http_get', 'net.http_delete', 'supabase_functions.http_request']);

const str = (n: PgNode | undefined): string | undefined => n?.String?.sval ?? n?.sval;
const qnameOfList = (list: PgNode[] | undefined): QName => {
    const parts = (list ?? []).map(str).filter((x) => x !== undefined);
    return parts.length >= 2 ? { schema: parts[parts.length - 2], name: parts[parts.length - 1] } : { schema: null, name: parts[0] };
};
const short = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ').trim();

/** Every string constant in a subtree. */
function strings(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) for (const x of node) strings(x, out);
    else if (node && typeof node === 'object') {
        const n = node as PgNode;
        if (n.A_Const?.sval) out.push(n.A_Const.sval.sval);
        for (const v of Object.values(node)) strings(v, out);
    }
    return out;
}

/**
 * Walks one parsed SQL statement list. Targets of INSERT/UPDATE/DELETE/MERGE/TRUNCATE are writes, every other
 * relation in it is a read; CTE names and `SELECT … INTO var` targets are not relations.
 */
function walkSql(stmts: unknown, facts: Facts): void {
    const ctes = new Set<string>();
    const skip = new Set<PgRangeVar>(); // RangeVar objects already counted as write targets / into targets
    const collectCtes = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(collectCtes);
        else if (node && typeof node === 'object') {
            const n = node as PgNode;
            if (n.CommonTableExpr?.ctename) ctes.add(n.CommonTableExpr.ctename);
            Object.values(node).forEach(collectCtes);
        }
    };
    collectCtes(stmts);
    // an unqualified pg_* name is the system catalog
    const rel = (rv: PgRangeVar): QName => ({ schema: rv.schemaname ?? (rv.relname.startsWith('pg_') ? 'pg_catalog' : null), name: rv.relname });

    const visit = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (!n || typeof n !== 'object') return;
        const node = n as PgNode;
        if (node.InsertStmt) {
            const s = node.InsertStmt;
            skip.add(s.relation);
            add(facts.writes, rel(s.relation), 'insert');
            if (s.onConflictClause?.action === 'ONCONFLICT_UPDATE') add(facts.writes, rel(s.relation), 'update');
        }
        if (node.UpdateStmt) {
            skip.add(node.UpdateStmt.relation);
            add(facts.writes, rel(node.UpdateStmt.relation), 'update');
        }
        if (node.DeleteStmt) {
            skip.add(node.DeleteStmt.relation);
            add(facts.writes, rel(node.DeleteStmt.relation), 'delete');
        }
        if (node.MergeStmt) {
            skip.add(node.MergeStmt.relation);
            add(facts.writes, rel(node.MergeStmt.relation), 'merge');
        }
        if (node.TruncateStmt)
            for (const r of node.TruncateStmt.relations ?? [])
                if (r.RangeVar) {
                    skip.add(r.RangeVar);
                    add(facts.writes, rel(r.RangeVar), 'truncate');
                }
        if (node.SelectStmt?.intoClause?.rel) skip.add(node.SelectStmt.intoClause.rel);
        if (node.CreateStmt?.relation) {
            // temp tables a body creates
            skip.add(node.CreateStmt.relation);
            facts.temp.add(node.CreateStmt.relation.relname);
        }
        if (node.LockingClause) for (const r of node.LockingClause.lockedRels ?? []) if (r.RangeVar) skip.add(r.RangeVar); // FOR UPDATE OF <alias>
        if (node.RangeVar && !skip.has(node.RangeVar)) {
            const rv = node.RangeVar;
            if (!(rv.schemaname == null && ctes.has(rv.relname))) add(facts.reads, rel(rv), 'select');
        }
        if (node.FuncCall) {
            const q = qnameOfList(node.FuncCall.funcname);
            const full = q.schema ? `${q.schema}.${q.name}` : q.name;
            if (HTTP_FUNCS.has(full)) {
                const urls = strings(node.FuncCall.args).filter((s) => /\/functions\/v1\/|^https?:\/\//.test(s));
                facts.http.push({ url: urls[0] ?? null, expr: full });
            } else if (q.schema !== 'pg_catalog') facts.calls.set(key(q), q);
        }
        for (const v of Object.values(node)) visit(v);
    };
    visit(stmts);
}

/** Parses SQL text (one or more statements); false when the parser refuses it. */
function trySql(text: string, facts: Facts): boolean {
    try {
        walkSql(parseSync(text).stmts ?? [], facts);
        return true;
    } catch {
        return false;
    }
}

/** A PL/pgSQL expression: a full statement, a bare expression, or an assignment `v := expr`. */
function sqlOfExpr(query: string, facts: Facts): void {
    if (trySql(query, facts)) return;
    if (trySql(`SELECT ${query}`, facts)) return;
    const m = /^[\s\S]*?:=([\s\S]*)$/.exec(query) ?? /^\s*[\w.[\]"]+\s*=([\s\S]*)$/.exec(query);
    if (m && trySql(`SELECT ${m[1]}`, facts)) return;
    facts.unresolved.push({ kind: 'parse', expr: short(query) });
}

function walkPl(n: unknown, facts: Facts): void {
    if (Array.isArray(n)) return n.forEach((x) => walkPl(x, facts));
    if (!n || typeof n !== 'object') return;
    const node = n as PgNode;
    for (const k of ['PLpgSQL_stmt_dynexecute', 'PLpgSQL_stmt_dynfors'] as const) {
        if (node[k]) {
            const q = node[k].query?.PLpgSQL_expr?.query ?? '';
            facts.unresolved.push({ kind: 'dynamic-sql', expr: short(`EXECUTE ${q}`) });
        }
    }
    if (node.PLpgSQL_stmt_return_query?.dynquery) {
        facts.unresolved.push({ kind: 'dynamic-sql', expr: short(`RETURN QUERY EXECUTE ${node.PLpgSQL_stmt_return_query.dynquery.PLpgSQL_expr?.query ?? ''}`) });
    }
    if (node.PLpgSQL_expr?.query !== undefined) sqlOfExpr(node.PLpgSQL_expr.query, facts);
    for (const v of Object.values(node)) walkPl(v, facts);
}

/** A unique dollar-quote tag that does not occur in the body. */
const dollar = (body: string): string => {
    let tag = '$arch$';
    for (let i = 0; body.includes(tag); i++) tag = `$arch${i}$`;
    return tag;
};

/** Facts of one function from the snapshot ({ schema, name, args, returns, language, body }). */
export function analyzeFunction(fn: Pick<SnapFunction, 'schema' | 'name' | 'args' | 'returns' | 'language'> & { body?: string | null }): Facts {
    const facts = newFacts();
    const body = fn.body ?? '';
    if (fn.language === 'sql') {
        if (!body.trim()) return facts;
        if (!trySql(body, facts)) facts.unresolved.push({ kind: 'parse', expr: short(body) });
        return dropTemp(facts);
    }
    if (fn.language !== 'plpgsql') return facts;
    const tag = dollar(body);
    const returns = /^TABLE\(|^SETOF /i.test(fn.returns ?? '') || !fn.returns ? fn.returns || 'void' : fn.returns;
    const src = `CREATE FUNCTION "${fn.schema}"."${fn.name}"(${fn.args}) RETURNS ${returns} LANGUAGE plpgsql AS ${tag}${body}${tag};`;
    let tree: unknown;
    try {
        tree = parsePlPgSQLSync(src);
    } catch {
        // The PL/pgSQL parser also checks variables (a `%ROWTYPE` record's fields, `%TYPE` scalars) and refuses
        // what only the catalog could confirm. Then each statement of the body goes to the SQL parser alone.
        statementsFallback(body, facts);
        return dropTemp(facts);
    }
    walkPl(tree, facts);
    return dropTemp(facts);
}

/** Tables the body creates itself (temporary work tables) are not the schema's. */
function dropTemp(facts: Facts): Facts {
    for (const map of [facts.reads, facts.writes]) for (const [k, v] of map) if (v.q.schema == null && facts.temp.has(v.q.name)) map.delete(k);
    return facts;
}

/** Splits a PL/pgSQL body on top-level `;` (outside quotes, dollar quotes and comments). */
function splitStatements(body: string): string[] {
    const out: string[] = [];
    let cur = '';
    for (let i = 0; i < body.length; ) {
        const rest = body.slice(i);
        const dq = /^\$[A-Za-z_]*\$/.exec(rest);
        let m: RegExpExecArray | null;
        if (dq) {
            const end = body.indexOf(dq[0], i + dq[0].length);
            const stop = end < 0 ? body.length : end + dq[0].length;
            cur += body.slice(i, stop);
            i = stop;
        } else if (body[i] === "'" || body[i] === '"') {
            const q = body[i];
            let j = i + 1;
            while (j < body.length && !(body[j] === q && body[j + 1] !== q)) j += body[j] === q ? 2 : 1;
            cur += body.slice(i, j + 1);
            i = j + 1;
        } else if ((m = /^--[^\n]*/.exec(rest))) i += m[0].length;
        else if (rest.startsWith('/*')) {
            const end = body.indexOf('*/', i + 2);
            i = end < 0 ? body.length : end + 2;
        } else if (body[i] === ';') {
            out.push(cur);
            cur = '';
            i++;
        } else cur += body[i++];
    }
    if (cur.trim()) out.push(cur);
    return out;
}

const STMT = /\b(with|select|insert\s+into|update|delete\s+from|merge\s+into|perform|return\s+query)\b/i;
const DYNAMIC = /\bexecute\b(?!\s+(function|procedure)\b)/i;

function statementsFallback(body: string, facts: Facts): void {
    for (const chunk of splitStatements(body)) {
        // a control line (`IF … THEN`, `LOOP`, `BEGIN`, `ELSE`) may stand before the statement in the same chunk
        let s = chunk.replace(/^[\s\S]*?\b(then|else|loop|begin)\b(?![\s\S]*\b(then|else|loop|begin)\b[\s\S]*\b(select|insert|update|delete|with|perform)\b)/i, '');
        if (DYNAMIC.test(s) && !STMT.test(s.split(DYNAMIC)[0])) {
            facts.unresolved.push({ kind: 'dynamic-sql', expr: short(s) });
            continue;
        }
        const tmp = /\bcreate\s+(?:temp|temporary)\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)/i.exec(s);
        if (tmp) {
            facts.temp.add(tmp[1]);
            continue;
        }
        const m = STMT.exec(s);
        if (!m) continue; // an assignment of a plain expression, RAISE, RETURN x, END IF, …
        s = s.slice(m.index);
        if (/^perform\b/i.test(s)) s = s.replace(/^perform\b/i, 'SELECT');
        if (/^return\s+query\b/i.test(s)) s = s.replace(/^return\s+query\b/i, '');
        const noInto = s
            .replace(/(\breturning\b[\s\S]*?)\binto\s+(strict\s+)?[\w.,\s]+$/i, '$1') // `… RETURNING id INTO v_id`
            .replace(/\binto\s+(strict\s+)?[\w.,\s]+?(?=\bfrom\b)/i, ''); // `SELECT a INTO v FROM …`
        if (!trySql(s, facts) && !trySql(noInto, facts)) facts.unresolved.push({ kind: 'parse', expr: short(s) });
    }
}

/** Facts of a plain SQL text (a cron command). */
export function analyzeSql(text: string): Facts {
    const facts = newFacts();
    if (!trySql(text, facts)) facts.unresolved.push({ kind: 'parse', expr: short(text) });
    return facts;
}
