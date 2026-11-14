// Pure helpers of scripts/check-lint-warnings.ts (kept apart so the test can import them without running eslint).
import { relative, sep } from 'node:path';

/** `file::rule` baseline key; the file is repo-relative with '/' on every platform. */
export function warningKey(root: string, filePath: string, ruleId: string | null): string {
    return `${relative(root, filePath).split(sep).join('/')}::${ruleId}`;
}

/** Why an eslint run cannot be trusted, or null. Status 0 = clean, 1 = lint errors (reported from the JSON); anything else (2 = fatal, a signal, no status) is a broken run whatever stdout says. */
export function eslintRunProblem(status: number | null, signal: string | null): string | null {
    if (signal) return `eslint was killed by ${signal}`;
    if (status === null) return 'eslint exited without a status';
    if (status !== 0 && status !== 1) return `eslint exited with status ${status}`;
    return null;
}
