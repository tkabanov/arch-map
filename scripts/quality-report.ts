// Code-quality report: the top functions by cyclomatic complexity and by length, file sizes, and lint warnings by
// rule — the numbers behind docs/code-quality.md. Reads only; changes nothing.
// It runs ESLint (eslint.config.js) with `complexity` and `max-lines-per-function` lowered to 0 so every function
// reports its value.
// Usage: node scripts/quality-report.ts [--top N] [--json]
import { ESLint } from 'eslint';
import { relative } from 'node:path';

/** A function as the report lists it. */
interface Fn {
    at: string;
    name: string;
    complexity: number;
    lines: number;
}

const argv = process.argv.slice(2);
const top = Number(argv[argv.indexOf('--top') + 1]) || 20;
const cwd = process.cwd();
const rel = (p: string): string => relative(cwd, p);

const lint = new ESLint({ cwd });
const regular = await lint.lintFiles(['.']);
const warnings: Record<string, number> = {};
// (a message without a rule — a parse error — counts under `null`, as before)
for (const f of regular) for (const m of f.messages) if (m.severity === 1) warnings[m.ruleId as string] = (warnings[m.ruleId as string] ?? 0) + 1;

const measure = new ESLint({
    cwd,
    overrideConfig: {
        rules: { complexity: ['warn', { max: 0 }], 'max-lines-per-function': ['warn', { max: 0, skipBlankLines: true, skipComments: true, IIFEs: true }] },
    },
});
const all = await measure.lintFiles(['.']);
const fns = new Map<string, Fn>();
for (const f of all) {
    for (const m of f.messages) {
        const key = `${rel(f.filePath)}:${m.line}`;
        const name = m.message.match(/^(?:(?:Async )?(?:Arrow )?[Ff]unction|Method|Getter|Setter|Constructor|Static method|Async method|Private method|Async arrow function)(?: '([^']+)')?|^(.+?) has (?:a complexity|too many lines)/)?.[1] ?? m.message.split(' has ')[0];
        const fn = fns.get(key) ?? { at: key, name: name.replace(/^(Async )?(Arrow )?[Ff]unction |^Method /, ''), complexity: 0, lines: 0 };
        if (m.ruleId === 'complexity') fn.complexity = Number(m.message.match(/complexity of (\d+)/)?.[1] ?? 0);
        if (m.ruleId === 'max-lines-per-function') fn.lines = Number(m.message.match(/too many lines \((\d+)\)/)?.[1] ?? 0);
        fns.set(key, fn);
    }
}
const list = [...fns.values()];
const byComplexity = [...list].sort((a, b) => b.complexity - a.complexity || b.lines - a.lines).slice(0, top);
const byLength = [...list].sort((a, b) => b.lines - a.lines || b.complexity - a.complexity).slice(0, top);
const over = (k: 'complexity' | 'lines', n: number): number => list.filter((f) => f[k] > n).length;
const summary = {
    functions: list.length,
    complexityOver10: over('complexity', 10),
    complexityOver15: over('complexity', 15),
    complexityOver25: over('complexity', 25),
    linesOver50: over('lines', 50),
    linesOver80: over('lines', 80),
    linesOver150: over('lines', 150),
};
const perFile: Record<string, { functions: number; complexitySum: number; over15: number }> = {};
for (const f of list) {
    const file = f.at.slice(0, f.at.lastIndexOf(':'));
    const p = (perFile[file] ??= { functions: 0, complexitySum: 0, over15: 0 });
    p.functions++;
    p.complexitySum += f.complexity;
    if (f.complexity > 15) p.over15++;
}
const files = Object.entries(perFile).sort((a, b) => b[1].complexitySum - a[1].complexitySum).slice(0, 10);

if (argv.includes('--json')) {
    console.log(JSON.stringify({ summary, warnings, byComplexity, byLength, files: Object.fromEntries(files) }, null, 2));
} else {
    const row = (f: Fn, i: number): string => `| ${i + 1} | \`${f.name}\` | ${f.complexity} | ${f.lines} | \`${f.at}\` |`;
    console.log(`Functions: ${summary.functions}; complexity >10: ${summary.complexityOver10}, >15: ${summary.complexityOver15}, >25: ${summary.complexityOver25}; ` + `lines >50: ${summary.linesOver50}, >80: ${summary.linesOver80}, >150: ${summary.linesOver150}`);
    console.log('\nLint warnings by rule:');
    for (const [r, n] of Object.entries(warnings).sort((a, b) => b[1] - a[1])) console.log(`| \`${r}\` | ${n} |`);
    console.log(`\nTop ${top} by cyclomatic complexity:\n| # | Function | Complexity | Lines | Where |\n|---|---|---|---|---|`);
    byComplexity.forEach((f, i) => console.log(row(f, i)));
    console.log(`\nTop ${top} by length (lines without blanks and comments):\n| # | Function | Complexity | Lines | Where |\n|---|---|---|---|---|`);
    byLength.forEach((f, i) => console.log(row(f, i)));
    console.log('\nFiles by total complexity:\n| File | Functions | Σ complexity | >15 |\n|---|---|---|---|');
    for (const [f, p] of files) console.log(`| \`${f}\` | ${p.functions} | ${p.complexitySum} | ${p.over15} |`);
}
