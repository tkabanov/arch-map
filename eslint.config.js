// ESLint flat config (code-quality pass 1, docs/code-quality.md). `npm run lint`.
// eslint:recommended plus size and complexity limits. The limits are warnings for now: the baseline is recorded in the
// doc and the next pass tightens them. Errors are for real mistakes (undefined names, unused code, unreachable code).
// `.ts` (TypeScript conventions in docs/code-quality.md): typescript-eslint's recommended set (syntax only, no type-aware rules — tsc does the types)
// on top, with the same limits and the TS versions of the core rules that know about types.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Size and complexity limits, all warnings in pass 1. */
const limits = {
    complexity: ['warn', { max: 15 }],
    'max-depth': ['warn', { max: 4 }],
    'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
    'max-lines': ['warn', { max: 600, skipBlankLines: true, skipComments: true }],
    'max-params': ['warn', { max: 5 }],
    'max-nested-callbacks': ['warn', { max: 4 }],
};

const unusedVars = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }];
const common = {
    ...limits,
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-var': 'error',
    'prefer-const': ['error', { destructuring: 'all' }],
    'no-param-reassign': 'off',
};
const TS = ['**/*.ts'];

export default [
    { ignores: ['node_modules/', 'dist/', '**/dist/', 'viewer/dist/', '.playwright-mcp/', 'viewer/public/', '_*/', '**/sources/', '**/specs/', 'types/spec.d.ts', '**/test/fixtures/'] },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: { ...common, 'no-unused-vars': unusedVars, 'no-shadow': 'warn' },
    },
    // TypeScript: the parser and the recommended rules, for `.ts` only
    ...tseslint.configs.recommended.map((c) => ({ ...c, files: TS })),
    {
        files: TS,
        languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: {
            ...common,
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': unusedVars,
            'no-shadow': 'off',
            '@typescript-eslint/no-shadow': 'warn',
            // a boundary (JSON.parse, an untyped library) gets `unknown` or a named type, not `any` — 08-code-quality.md
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    // the generators, the checks and the tests run on Node
    { files: ['scripts/**/*.{mjs,ts}', 'test/**/*.{mjs,ts}', '*.js', '*.mjs', '*.cjs', '*.ts'], languageOptions: { globals: { ...globals.node } } },
    // the viewer runs in the browser
    { files: ['viewer/**/*.{js,ts}'], ignores: ['viewer/src/core/**'], languageOptions: { globals: { ...globals.browser } } },
    // the shared pure core: no DOM, no Node — only the language (and the console)
    { files: ['viewer/src/core/**/*.{js,ts}'], languageOptions: { globals: { console: 'readonly' } } },
    // tests are long describe/it blocks by nature
    { files: ['test/**/*.{mjs,ts}'], rules: { 'max-lines-per-function': 'off', 'max-nested-callbacks': 'off' } },
];
