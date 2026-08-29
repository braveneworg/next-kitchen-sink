import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Importing a script must never touch the filesystem or end the process.
 *
 * `scripts/init-from-template.ts` imports pure helpers from the coverage gate.
 * When the gate resolved its thresholds at module scope, that import read
 * `process.cwd()/vitest.config.ts` and called `process.exit(1)` when the file
 * was absent — so merely importing the initialiser could kill its host before a
 * single line of it ran.
 *
 * Each script is imported from a directory that deliberately contains no
 * `vitest.config.ts`. A script whose module scope is inert exits 0.
 */
const REPO_ROOT = path.join(import.meta.dirname, '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const SCRIPTS = ['coverage-gate.ts', 'check-coverage-regression.ts', 'init-from-template.ts'];

describe('script import safety', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'no-vitest-config-'));
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  it.each(SCRIPTS)('imports %s from a directory with no vitest.config.ts', (script) => {
    const target = pathToFileURL(path.join(import.meta.dirname, script)).href;

    // `.then` rather than top-level await: `tsx -e` evaluates as CJS, where TLA
    // is a syntax error, which would fail this spec for the wrong reason.
    const source = `import(${JSON.stringify(target)}).then(() => { console.info('imported'); });`;
    const result = spawnSync(TSX_BIN, ['-e', source], { cwd, encoding: 'utf-8' });

    expect({ status: result.status, stderr: result.stderr.trim() }).toEqual({ status: 0, stderr: '' });
  });
});
