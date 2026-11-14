// The side panel: a short summary first (who uses it, what it touches, where it goes), details below,
// code details folded. Relations are listed at full resolution, whatever the map currently folds.
// Besides spec-adapter.js, the «Code details» section is the only reader of facets (AD-12): it lists them as they are.
import { MAX_STEPS } from './core/path.ts';
import { KINDS, ancestors, summary, kindGroup, countEndpoints } from './model.ts';
import { blockFigures, summaryHeads, cardFigures, figuresHtml, figuresText } from './figures.ts';
import { esc } from './scene-util.ts';
import { edgeCount } from './scene-edges.ts';
import { resolvePointer, splitKey } from './core/resolve.ts';
import { edgesEnvelopes, envelopeOf, edgesWith, hasPolicies, shownFields, SIDES } from './envelopes.ts';
import type { Access, Contract, ElementId } from '../../types/spec.d.ts';
import type { SummaryEntry } from '../../types/core.ts';
import type { ContractApi, ContractDocs, Envelope, EnvelopeSides, FoldedEdge, Model, OpenApiOperation, PanelContext, Side, ViewEdge, ViewNode, ViewPath } from '../../types/viewer.ts';

/** The part of a JSON Schema (or an OpenAPI schema) the panel reads. */
interface Schema {
    $ref?: string;
    type?: string;
    format?: string;
    items?: Schema;
    enum?: unknown[];
    oneOf?: Schema[];
    anyOf?: Schema[];
    allOf?: Schema[];
    properties?: Record<string, Schema>;
    required?: string[];
    description?: string;
}

const KIND_LABEL: Record<string, string> = {
    rest: 'REST', read: 'read', write: 'write', data: 'data', event: 'event', trigger: 'trigger', schedule: 'schedule',
    webhook: 'webhook', https: 'HTTPS', smtp: 'SMTP', call: 'call', import: 'import', references: 'FK', interacts: 'uses',
    break: 'break',
};
/** The tag's color is the map's own (`--k-<group>` on its host, theme-apply.ts): the panel's markup is the same on every theme. */
const tagColor = (kind: string): string => {
    if (kind === 'break') return 'break';
    const g = kind === 'data' ? 'data' : kindGroup(kind);
    return KINDS[g] ? g : 'other';
};
export const tag = (kind: string): string => `<span class="tag" data-style="--c:var(--k-${tagColor(kind)})">${esc(KIND_LABEL[kind] ?? kind)}</span>`;
const cnt = (n: number, one: string, few: string, many: string) => `<b>${n}</b> ${plural(n, one, few, many)}`;
const method = (m: string) => `<span class="m m-${m}">${m}</span>`;
const plural = (n: number, one: string, few: string, many: string) => (n === 1 ? one : many); // English: one / many (`few` kept for the call sites)

// ---------- contracts (AD-7): REST = the backend's OpenAPI, the rest = JSON Schema `$defs` ----------
/** Index of the loaded contract documents: docs by name, OpenAPI operations by `doc#operationId`. */
export function contractIndex(contractDocs: ContractDocs): ContractApi {
    const ops: ContractApi['ops'] = new Map();
    for (const [doc, json] of contractDocs) {
        const spec = json as { paths?: Record<string, Record<string, OpenApiOperation | undefined>> } | null | undefined; // an OpenAPI document, or a JSON Schema one without `paths`
        if (!spec?.paths) continue;
        for (const [path, item] of Object.entries(spec.paths))
            for (const [m, op] of Object.entries(item)) if (op?.operationId) ops.set(`${doc}#${op.operationId}`, { path, method: m.toUpperCase(), op });
    }
    return { docs: contractDocs, ops };
}

function schemaType(s: Schema | undefined, doc: string): string {
    if (!s) return '';
    if (s.$ref) {
        const name = s.$ref.split('/').pop();
        // filled on open: DTOs here are recursive, so nested schemas are never rendered ahead of time
        return `<details class="ref" data-schema="${esc(doc + s.$ref)}"><summary>${esc(name)}</summary></details>`;
    }
    if (s.type === 'array') return `${schemaType(s.items, doc)}<span class="arr">[ ]</span>`;
    if (s.enum) return `${esc(s.type ?? '')} <span class="enum">${s.enum.map((v) => esc(v)).join(' | ')}</span>`;
    for (const k of ['oneOf', 'anyOf', 'allOf'] as const) if (s[k]) return s[k].map((x) => schemaType(x, doc)).join(k === 'allOf' ? ' & ' : ' | ');
    return `<span class="t">${esc([s.type, s.format].filter(Boolean).join(' · ') || 'object')}</span>`;
}

function fieldsTable(s: Schema | undefined, doc: string): string {
    if (!s) return '<p class="muted">schema not found</p>';
    if (!s.properties) return `<p>${schemaType(s, doc)}</p>`;
    const req = new Set(s.required ?? []);
    return `<table class="fields"><tbody>${Object.entries(s.properties)
        .map(([k, v]) => `<tr><td><code>${esc(k)}</code>${req.has(k) ? '<span class="req" title="required">*</span>' : ''}</td><td>${schemaType(v, doc)}${v.description ? `<div class="muted small">${esc(v.description)}</div>` : ''}</td></tr>`)
        .join('')}</tbody></table>`;
}

const schemaAt = (api: ContractApi, key: string): Schema | undefined => {
    const { doc, pointer } = splitKey(key);
    const d = api.docs.get(doc);
    return d ? (resolvePointer(d, pointer) as Schema | undefined) : undefined;
};

/** Renders a nested schema the first time its <details> is opened. */
export function fillSchema(details: HTMLDetailsElement, api: ContractApi): void {
    if (details.dataset.filled || !details.open) return;
    details.dataset.filled = '1';
    const key = details.dataset.schema!; // the selector it is called for: details[data-schema]
    details.insertAdjacentHTML('beforeend', fieldsTable(schemaAt(api, key), splitKey(key).doc));
}

/** Access in plain words (AD-9). */
function accessText(a: Access | null | undefined): string {
    if (!a) return '—';
    const level = ({ public: 'no sign-in', authenticated: 'signed in', restricted: 'restricted' } as Record<string, string>)[a.level] ?? a.level;
    const bits = [level];
    if (a.roles?.length) bits.push(`roles: ${a.roles.join(', ')}`);
    if (a.guards?.length) bits.push(a.guards.join(', '));
    if (a.policies?.length) bits.push(`policies: ${a.policies.join('; ')}`);
    return bits.join(' · ');
}
const authLabel = (a: Access | null | undefined): string => {
    if (!a) return '';
    if (a.level === 'public') return '<span class="pub">no sign-in</span>';
    if (a.level === 'authenticated') return '<span class="auth">sign-in</span>';
    const g = a.guards?.[0] ?? a.roles?.[0] ?? '';
    return `<span class="auth" title="${esc(accessText(a))}">permission ${esc(g.replace(/^Can\(/, '').split(/[,)]/)[0])}</span>`;
};

function contractHtml(contract: Contract | null | undefined, access: Access | null | undefined, api: ContractApi): string {
    if (!contract) return access ? `<div class="contract"><dl class="kv"><dt>Access</dt><dd>${esc(accessText(access))}</dd></dl></div>` : '';
    const doc = contract.doc;
    if (!api.docs.get(doc)) return `<p class="muted">Contract <code>${esc(doc)}</code> ${api.docs.pending?.(doc) ? 'is loading…' : 'is not loaded.'}</p>`;
    const found = contract.operationId && api.ops.get(`${doc}#${contract.operationId}`);
    const head = `<dl class="kv"><dt>Access</dt><dd>${esc(accessText(access))}</dd>${contract.operationId ? `<dt>operationId</dt><dd><code>${esc(contract.operationId)}</code></dd>` : ''}</dl>`;
    if (!found) {
        // a JSON Schema contract: request / response named by pointer
        const side = (title: string, pointer: string | undefined) => (pointer ? `<h5>${title}</h5><div class="schema-name">${esc(pointer.split('/').pop())}</div>${fieldsTable(resolvePointer(api.docs.get(doc), pointer) as Schema | undefined, doc)}` : '');
        return `<div class="contract">${head}${side('Request', contract.request)}${side('Response', contract.response)}</div>`;
    }
    const { op } = found;
    const params = (op.parameters ?? []).map((p) => `<tr><td><code>${esc(p.name)}</code>${p.required ? '<span class="req">*</span>' : ''}</td><td class="muted">${esc(p.in)}</td><td>${schemaType(p.schema as Schema | undefined, doc)}</td></tr>`);
    const body = (op.requestBody?.content && Object.values(op.requestBody.content)[0]?.schema) as Schema | undefined;
    const responses = Object.entries(op.responses ?? {}).map(([code, r]) => {
        const s = (r.content && Object.values(r.content)[0]?.schema) as Schema | undefined;
        return `<li><b>${esc(code)}</b> ${s ? schemaType(s, doc) : '<span class="muted">body not described</span>'}</li>`;
    });
    return `<div class="contract">${head}
      ${params.length ? `<h5>Parameters</h5><table class="fields"><tbody>${params.join('')}</tbody></table>` : ''}
      ${body ? `<h5>Request body</h5>${body.$ref ? `<div class="schema-name">${esc(body.$ref.split('/').pop())}</div>${fieldsTable(resolvePointer(api.docs.get(doc), body.$ref) as Schema | undefined, doc)}` : fieldsTable(body, doc)}` : ''}
      ${responses.length ? `<h5>Responses</h5><ul class="resp">${responses.join('')}</ul>` : ''}
    </div>`;
}

/** Who calls each endpoint of a component: endpoint id → call sites (REST) or callers (webhooks and the rest). */
function callersOf(model: Model, componentId: ElementId): Map<ElementId, string[]> {
    const out = new Map<ElementId, string[]>();
    for (const e of model.edges) {
        if (!e.endpoint || e.to !== componentId) continue;
        const list = out.get(e.endpoint) ?? out.set(e.endpoint, []).get(e.endpoint)!;
        if (e.kind === 'rest') for (const item of e.items) list.push(item.split(' ← ')[1] ?? model.nodes.get(e.from)?.title ?? e.from);
        else list.push(model.nodes.get(e.from)?.title ?? e.from);
    }
    return out;
}

function endpointsHtml(n: ViewNode, ctx: PanelContext): string {
    if (!n.endpoints?.length) return '';
    const callers = callersOf(ctx.model, n.id);
    return `<section><h4>Endpoints <span class="count">${n.endpoints.length}</span></h4><div class="eps">${n.endpoints
        .map((ep) => {
            const who = callers.get(ep.id) ?? [];
            return `<details class="ep"><summary>${method(ep.method)}<code class="p">${esc(ep.path)}</code>${authLabel(ep.access)}${who.length ? `<span class="callers-n" title="callers">${who.length}↙</span>` : ''}</summary>
              ${ep.handler ? `<div class="ep-actions"><button class="btn small" data-path="${esc(n.id)}|${esc(ep.handler)}">Path ▶</button></div>` : ''}
              ${who.length ? `<div class="callers">Called by: ${who.map((w) => `<code>${esc(w)}</code>`).join(' ')}</div>` : '<div class="callers muted">Nothing in the loaded specs calls it</div>'}
              ${contractHtml(ep.contract, ep.access, ctx.api)}</details>`;
        })
        .join('')}</div></section>`;
}

function columnsHtml(n: ViewNode): string {
    if (!n.columns?.length) return '';
    return `<section><h4>Columns <span class="count">${n.columns.length}</span></h4><table class="fields"><tbody>${n.columns
        .map((c) => `<tr><td><code>${esc(c.name)}</code>${c.pk ? ' <span class="pk">PK</span>' : ''}</td><td><span class="t">${esc(c.type)}</span>${c.nullable ? ' <span class="muted">null</span>' : ''}</td></tr>`)
        .join('')}</tbody></table></section>`;
}

// ---------- summary ----------
function rowsHtml(rows: (Omit<SummaryEntry, 'owner'> & { owner: { id: ElementId; title: string } })[], emptyText: string): string {
    if (!rows.length) return `<p class="muted small">${emptyText}</p>`;
    return `<ul class="rels">${rows
        .map(
            (g) =>
                `<li><button class="rel" data-node="${esc(g.owner.id)}">${tag(g.channel)}<span class="who">${esc(g.owner.title)}${g.extra.length ? `<span class="rwnote">${g.extra.includes('w') ? (g.extra.includes('r') ? 'read and write' : 'write') : 'read'}</span>` : ''}</span><span class="count">${g.n}</span></button></li>`,
        )
        .join('')}</ul>`;
}

function summaryHtml(n: ViewNode, ctx: PanelContext): string {
    const s = summary(ctx.model, n.id);
    const empty = { in: 'nothing in the loaded specs', tables: 'touches none', out: 'nothing outside itself' };
    // the hover card shows the same figures in the same words (cardStatsHtml, figures.ts)
    return summaryHeads(n, s)
        .map((h) => `<section class="sum"><h4>${h.title} <span class="count">${figuresText(h.figures)}</span></h4>${rowsHtml(s[h.list], empty[h.list])}</section>`)
        .join('');
}

/** The hover card's figures: the panel's summary headings' (figures.ts), and the endpoints. */
export function cardStatsHtml(n: ViewNode, s: ReturnType<typeof summary>): string {
    return `<div class="c-stats">${cardFigures(n, s, countEndpoints(n)).map((f) => `<span>${figuresHtml(f)}</span>`).join('')}</div>`;
}

function roleLine(n: ViewNode): string {
    const bits = [n.role];
    bits.push(...blockFigures(n, countEndpoints(n)).map((f) => `${f.n} ${f.unit}`));
    if (n.columns) bits.push(`${n.columns.length} columns`);
    if (n.context) bits.push('outside the slice');
    return bits.join(' · ');
}
export { countEndpoints } from './model.ts';

export function nodeHtml(n: ViewNode, ctx: PanelContext): string {
    const path = ancestors(ctx.model, n.id).reverse();
    const canPath = n.methods?.length;
    return `<header class="ph">
      <nav class="crumbs">${path.map((p) => `<button data-node="${esc(p.id)}">${esc(p.title)}</button>`).join('<span>›</span>')}</nav>
      <h3>${esc(n.title)}</h3>
      <div class="role">${esc(roleLine(n))}</div>
      <div class="actions">
        ${n.children.length && ctx.focus !== n.id && !ctx.rest?.has(n.id) ? `<button class="btn" data-focus="${esc(n.id)}" title="Go into this block: its parts and their relations">Enter ⤵</button>` : ''}
        ${canPath ? `<button class="btn ghost" data-path="${esc(n.id)}|*">Path ▶</button>` : ''}
        ${n.sourceUrl ? `<a class="btn ghost" href="${esc(n.sourceUrl)}" target="_blank" rel="noopener">Source ↗</a>` : ''}
      </div>
    </header>
    ${summaryHtml(n, ctx)}
    ${endpointsHtml(n, ctx)}
    ${columnsHtml(n)}
    ${codeHtml(n)}`;
}

const PROVENANCE: Record<string, string> = { extracted: 'from code', declared: 'from config', authored: 'written by hand' };

function codeHtml(n: ViewNode): string {
    const facets = Object.entries(n.facets ?? {});
    if (!n.file && !n.description && !n.deps?.length && !facets.length && !n.source) return '';
    const src = n.source as { config?: string; line?: number } | undefined; // a config source or a code source
    const where = src?.config ? src.config : n.file ? `${n.file}${src?.line ? `:${src.line}` : ''}` : '';
    return `<details class="code"><summary>Code details</summary>
      ${where ? `<div class="file"><code>${esc(where)}</code></div>` : ''}
      ${n.technology ? `<div class="muted small">${esc(n.technology)}</div>` : ''}
      ${n.provenance ? `<div class="muted small">${esc(PROVENANCE[n.provenance] ?? n.provenance)}${n.derivedFrom ? ` · grouped by rule ${esc(n.derivedFrom.rule)}: ${esc(n.derivedFrom.value)}${n.confidence ? `, confidence ${esc(n.confidence)}` : ''}` : ''}</div>` : ''}
      ${n.description ? `<p class="desc">${esc(n.description).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>` : ''}
      ${n.deps?.length ? `<h5>Dependencies</h5><ul class="plain">${n.deps.map((d) => `<li><code>${esc(d.name)}</code>${d.methods.length ? ` <span class="muted">${esc(d.methods.join(', '))}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${facets.length ? `<h5>Facets</h5><ul class="plain">${facets.map(([k, v]) => `<li><code>${esc(k)}</code>${Object.keys(v ?? {}).length ? ` <span class="muted">${esc(JSON.stringify(v))}</span>` : ''}</li>`).join('')}</ul>` : ''}
    </details>`;
}

// ---------- an edge ----------
export function edgeHtml(e: FoldedEdge, ctx: PanelContext): string {
    const a = ctx.model.nodes.get(e.from)!, b = ctx.model.nodes.get(e.to)!; // a drawn relation joins two nodes of the model
    const kinds = [...new Set(e.raw.map((r) => r.kind))];
    const n = edgeCount(e);
    // raw relations of one pair and channel go together: a component calls another from several methods
    const groups = new Map<string, ViewEdge[]>();
    for (const r of e.raw) {
        const k = `${r.from}|${r.to}|${r.kind}`;
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    return `<header class="ph">
      <div class="kind">relation</div>
      <h3><button class="lnk" data-node="${esc(a.id)}">${esc(a.title)}</button> <span class="muted">→</span> <button class="lnk" data-node="${esc(b.id)}">${esc(b.title)}</button></h3>
      <div class="tags">${kinds.map((k) => tag(k)).join('')} <span class="muted">${e.group === 'rest' ? `${n} ${plural(n, 'endpoint', 'endpoints', 'endpoints')}` : `${n} ${plural(n, 'relation', 'relations', 'relations')}`}</span></div>
    </header>
    ${rlsHtml(e.raw)}
    ${ctx.env ? envelopesHtml(edgesEnvelopes(ctx.env, e.raw)) : ''}
    <div class="raws">${[...groups.values()].map((rs) => rawHtml(rs, ctx)).join('')}</div>`;
}

function rawHtml(rs: ViewEdge[], ctx: PanelContext): string {
    const r = rs[0];
    const a = ctx.model.nodes.get(r.from), b = ctx.model.nodes.get(r.to);
    let body: string;
    if (r.kind === 'rest') {
        const endpoints = new Map<string, { where: string | undefined; op: ViewNode['endpoints'][number] | undefined; contract: Contract | null; access: Access | null }>(); // "METHOD path" → { where, op }
        for (const x of rs) {
            const op = b?.endpoints?.find((ep) => ep.id === x.endpoint);
            for (const it of x.items) {
                const [label, where] = it.split(' ← ');
                endpoints.set(label, { where, op, contract: x.contract, access: x.access });
            }
        }
        body = [...endpoints]
            .map(([label, { where, op, contract, access }]) => {
                const [m, ...rest] = label.split(' ');
                return `<details class="ep"><summary>${method(m)}<code class="p">${esc(rest.join(' '))}</code>${authLabel(access)}</summary>
                  ${op?.handler ? `<div class="ep-actions"><button class="btn small" data-path="${esc(b!.id)}|${esc(op.handler)}">Path ▶</button></div>` : ''}
                  ${where ? `<div class="callers">Call: <code>${esc(where)}</code></div>` : ''}${contractHtml(contract, access, ctx.api)}</details>`;
            })
            .join('');
    } else {
        const items = [...new Set(rs.flatMap((x) => x.items))];
        const withContract = rs.find((x) => x.contract || x.access);
        body = `<ul class="plain">${items.map((it) => `<li><code>${esc(it)}</code></li>`).join('')}</ul>${withContract ? contractHtml(withContract.contract, withContract.access, ctx.api) : ''}`;
    }
    const titles = [...new Set(rs.map((x) => x.title).filter(Boolean))];
    return `<section class="raw"><div class="raw-h">${tag(r.kind)}<span><b>${esc(a?.title ?? r.from)}</b> → <b>${esc(b?.title ?? r.to)}</b></span>${rs.length > 1 ? `<span class="count">${rs.length}</span>` : ''}</div>
      ${titles.length && r.kind !== 'rest' ? `<div class="muted small">${esc(titles.slice(0, 6).join(', '))}${titles.length > 6 ? ` +${titles.length - 6}` : ''}</div>` : ''}${body}</section>`;
}

// ---------- envelopes and row-level policies ----------
const ENV_SIDE: Record<Side, string> = { request: 'Request', response: 'Response' };
/** The same fields the map's open envelope lists, in one line. */
const fieldLine = (env: Envelope) => {
    const { fields, more } = shownFields(env);
    return esc(fields.map((f) => f.label).join(' · ')) + (more ? ` · ${more} more` : '');
};

/** «Envelopes»: request and response objects of a relation, every one of them, with their fields. */
function envelopesHtml(sides: EnvelopeSides): string {
    if (!SIDES.some((s) => sides[s].length)) return '';
    const total = sides.request.length + sides.response.length;
    return `<section><h4>Envelopes <span class="count">${total}</span></h4><div class="envs">${SIDES.flatMap((side) =>
        sides[side].map(({ env, n }) => `<button class="env ${side}" data-env="${esc(env.key)}" title="Where else it travels">
          <span class="env-h"><i>${ENV_SIDE[side]}</i><b>${esc(env.title)}</b>${n > 1 ? `<span class="count">${n}</span>` : ''}</span>
          <span class="env-f">${fieldLine(env)}</span></button>`),
    ).join('')}</div></section>`;
}

/** The lock (AD-9): who may see which rows of the table this relation touches. */
function rlsHtml(raws: ViewEdge[]): string {
    if (!hasPolicies(raws)) return '';
    const policies = [...new Set(raws.flatMap((r) => r.access?.policies ?? []))];
    return `<section class="rls"><h4><span class="lockmark" aria-hidden="true"></span>Rows are protected (RLS)</h4>
      <p class="small">The table returns only the rows its policies allow:</p><ul class="plain">${policies.map((x) => `<li>«${esc(x)}»</li>`).join('')}</ul></section>`;
}

/** One object: its fields under client-layer names and every relation it travels on. */
export function envelopeHtml(key: string, ctx: PanelContext): string {
    const env = envelopeOf(ctx.env!, key); // given for an envelope
    const { doc, pointer } = splitKey(key);
    const on = ctx.model.edges.filter((e) => edgesWith([e], key).length);
    const title = (id: ElementId) => ctx.model.nodes.get(id)?.title ?? id;
    const shown = ctx.folded!.filter((e) => edgesWith(e.raw, key).length).length;
    const inSteps = (ctx.scenarios ?? []).flatMap((sc) =>
        sc.steps.flatMap((st, i) => (SIDES.some((sd) => st.contract?.[sd] && `${st.contract.doc}${st.contract[sd]}` === key) ? [`“${sc.title}”, step ${i + 1}: ${st.caption}`] : [])),
    );
    return `<header class="ph"><div class="kind">envelope</div><h3>${esc(env.title)}</h3>
      <div class="role"><code>${esc(pointer.split('/').pop())}</code> · <span class="muted">${esc(doc)}</span></div></header>
      <section><h4>Fields <span class="count">${env.fields.length}</span></h4><table class="fields"><tbody>${env.fields
          .map((f) => `<tr><td>${esc(f.label)}</td><td><code>${esc(f.name)}</code></td></tr>`)
          .join('')}</tbody></table></section>
      <section><h4>Where it travels <span class="count">${on.length}</span></h4>
        <p class="small muted">${shown ? `${shown} ${plural(shown, 'relation is', 'relations are', 'relations are')} lit on the map.` : 'None of these relations is visible now: they are inside closed blocks.'}</p>
        <ul class="plain">${on
            .slice(0, 40)
            .map((e) => `<li>${tag(e.kind)} <code>${esc(title(e.from))} → ${esc(title(e.to))}</code> <span class="muted small">${SIDES.filter((s) => e.contract?.[s] && `${e.contract.doc}${e.contract[s]}` === key).map((s) => ENV_SIDE[s].toLowerCase()).join(', ')}</span></li>`)
            .join('')}</ul>${on.length > 40 ? `<p class="muted small">and ${on.length - 40} more</p>` : ''}</section>
      ${inSteps.length ? `<section><h4>In scenarios <span class="count">${inSteps.length}</span></h4><ul class="plain">${inSteps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}`;
}

// ---------- a path ----------
export function pathHtml(p: ViewPath, ctx: PanelContext): string {
    const title = (id: ElementId) => ctx.model.nodes.get(id)?.title ?? id;
    const nodes = new Set(p.steps.flatMap((s) => [s.from, s.to]));
    const tables = new Set(p.steps.filter((s) => s.kind === 'read' || s.kind === 'write').map((s) => s.to));
    const ext = new Set(p.steps.filter((s) => s.kind === 'https' || s.kind === 'smtp').map((s) => s.to));
    const events = p.steps.filter((s) => s.kind === 'event').length;
    const breaks = p.steps.filter((s) => s.kind === 'break').length;
    // a long path folds: two levels open, deeper ones behind «N steps inside»; a short one is one open list
    const kids = new Map<number, number[]>();
    p.steps.forEach((s, i) => (kids.get(s.parent ?? -1) ?? kids.set(s.parent ?? -1, []).get(s.parent ?? -1)!).push(i));
    const fold = p.steps.length > 60;
    const count = (i: number): number => (kids.get(i) ?? []).reduce((a, k) => a + 1 + count(k), 0);
    const row = (i: number): string => {
        const s = p.steps[i];
        const btn = `<button data-step="${i}" data-node="${esc(s.to)}"><span class="no">${i + 1}</span>${tag(s.kind)}<span class="who">${esc(title(s.to))}</span><span class="lbl">${esc(s.label)}${s.cycle ? ' <span title="Recursion: this method is already running above in this path; the path stops here">↻ cycle</span>' : ''}</span></button>`;
        const inner = kids.get(i);
        if (!fold || !inner?.length) return `<li data-style="--d:${Math.min(s.depth, 8)}">${btn}</li>${(inner ?? []).map(row).join('')}`;
        const open = s.depth < 2 ? ' open' : '';
        return `<li data-style="--d:${Math.min(s.depth, 8)}">${btn}</li><li class="fold" data-style="--d:${Math.min(s.depth + 1, 8)}"><details${open}><summary>${count(i)} ${plural(count(i), 'step', 'steps', 'steps')} inside</summary><ol class="steps">${inner.map(row).join('')}</ol></details></li>`;
    };
    // the steps keep their order: a parent is listed before its children (trace pushes it first)
    const rows = (kids.get(-1) ?? []).map(row).join('');
    return `<header class="ph"><div class="kind">path</div><h3>${esc(p.title)}</h3>
      <div class="role">${p.steps.length} ${plural(p.steps.length, 'step', 'steps', 'steps')} · ${nodes.size} components · ${tables.size} tables${ext.size ? ` · outside: ${[...ext].map(title).join(', ')}` : ''}${events ? ` · events: ${events}` : ''}${breaks ? ` · breaks: ${breaks}` : ''}</div>
      <div class="actions"><button class="btn ghost" data-closepath="1">Close the path</button></div></header>
      ${p.callers?.length ? `<section><h4>Called from</h4><ul class="plain">${p.callers.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul></section>` : ''}
      <section><h4>Steps</h4><ol class="steps">${rows}</ol>${p.steps.length >= (p.method === '*' ? 300 : MAX_STEPS) ? `<p class="muted small">The first ${p.steps.length} steps are shown.</p>` : ''}</section>`;
}

/** A one-line summary of the map: its systems, applications, tables and outside systems, and its relations. */
function summaryLine(model: Model): string {
    const by = (t: string) => [...model.nodes.values()].filter((n) => n.type === t).length;
    const parts = ([['system', 'systems'], ['app', 'applications'], ['table', 'tables'], ['external-system', 'external systems']] as const)
        .map(([t, many]) => [by(t), many] as const)
        .filter(([k]) => k)
        .map(([k, many]) => `${k} ${k === 1 ? many.replace(/s$/, '') : many}`);
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'Nothing placed yet');
    return `${list}; ${model.meta.counts.edges} ${plural(model.meta.counts.edges, 'relation', 'relations', 'relations')} in the specs.`;
}

/** The first scenario as the panel's main button, the others under it. */
function scenariosCta(scenarios: { id: string; title: string; steps: unknown[] }[]): string {
    if (!scenarios.length) return '';
    const [first, ...rest] = scenarios;
    const more = rest.length
        ? `<div class="sc-play">${rest.map((x) => `<button data-scenario="${esc(x.id)}"><i>▶</i><div><b>${esc(x.title)}</b><span>${x.steps.length} steps</span></div></button>`).join('')}</div>`
        : '';
    return `<section class="cta"><button class="btn sc-cta" data-scenario="${esc(first.id)}" title="Play it">▶ ${esc(first.title)} (${first.steps.length} steps)</button>
      <div class="muted small">Plays as a cinema: <kbd>Space</kbd> pauses, <kbd>←</kbd> <kbd>→</kbd> step, <kbd>Esc</kbd> leaves.</div>${more}</section>`;
}

/**
 * The first panel: the project and what is on the map, the main scenario, how to look; the spec documents, their
 * commits and the full counts folded under «Sources».
 */
export function overviewHtml(model: Model, project: { title: string }, scenarios: { id: string; title: string; steps: unknown[] }[] = []): string {
    const by = (t: string) => [...model.nodes.values()].filter((n) => n.type === t).length;
    const eps = [...model.nodes.values()].reduce((a, n) => a + (n.endpoints?.length ?? 0), 0);
    const repos = Object.entries(model.meta.repos ?? {});
    return `<header class="ph"><div class="kind">project</div><h3>${esc(project.title)}</h3><div class="role">${esc(summaryLine(model))}</div>
      ${model.meta.nofacets ? '<div class="role">without facets (?nofacets=1)</div>' : ''}</header>
      ${scenariosCta(scenarios)}
      <section><h4>How to look</h4><ul class="plain help">
        <li><b>Hover</b> a block for a card with the essentials and an “Enter” button.</li>
        <li><b>Double-click</b> or <b>wheel</b> toward a block to go inside; zoom out or <b>Esc</b> to leave.</li>
        <li><b>Click</b> for a summary here: who uses it, which tables, what it talks to.</li>
        <li><b>Path ▶</b> on an endpoint or component shows the whole call chain down to the tables.</li>
        <li><b>Drag</b> pans, <b>Shift + drag</b> rotates. The browser’s <b>Back / Forward</b> move between places.</li>
        <li><b>?</b> opens every control and shortcut.</li></ul></section>
      <details class="sources"><summary>Sources <span class="count">${model.meta.docs.length} ${plural(model.meta.docs.length, 'spec', 'specs', 'specs')}</span></summary>
        <ul class="plain docs">${model.meta.docs.map((d) => `<li>${esc(d.title)}</li>`).join('')}</ul>
        ${repos.length ? `<div class="role">${repos.map(([k, r]) => `${esc(k)} <code>${esc(String(r.commit).slice(0, 8))}</code>`).join(' · ')}</div>` : ''}
        <ul class="plain stats">
        <li>${cnt(by('system'), 'system', 'systems', 'systems')}, ${cnt(by('app'), 'application', 'applications', 'applications')}, ${cnt(by('module'), 'module', 'modules', 'modules')}</li>
        <li>${cnt(by('component'), 'component', 'components', 'components')}, ${cnt(eps, 'endpoint', 'endpoints', 'endpoints')}</li>
        <li>${cnt(by('table'), 'table', 'tables', 'tables')}, ${cnt(by('external-system'), 'external system', 'external systems', 'external systems')}</li>
        <li>${cnt(model.meta.counts.edges, 'relation', 'relations', 'relations')} in the specs</li></ul></details>`;
}
