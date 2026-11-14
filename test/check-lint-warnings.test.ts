// The helpers of scripts/check-lint-warnings.ts: baseline keys are '/'-separated on every platform; an eslint run that
// is not a clean or lint-errors exit is rejected, so it cannot pass the ratchet or overwrite the baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { warningKey, eslintRunProblem } from '../scripts/lib/lint-warnings.ts';

test('warningKey: repo-relative, forward slashes', () => {
    const root = join('repo', 'root');
    assert.equal(warningKey(root, join(root, 'scripts', 'lib', 'x.ts'), 'complexity'), 'scripts/lib/x.ts::complexity');
});

test('eslintRunProblem: 0 and 1 are trusted, everything else is not', () => {
    assert.equal(eslintRunProblem(0, null), null);
    assert.equal(eslintRunProblem(1, null), null);
    assert.match(eslintRunProblem(2, null)!, /status 2/);
    assert.match(eslintRunProblem(null, 'SIGKILL')!, /SIGKILL/);
    assert.match(eslintRunProblem(null, null)!, /without a status/);
});
