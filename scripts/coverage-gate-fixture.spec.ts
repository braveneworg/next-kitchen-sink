import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import vitestConfig from '../vitest.config';

/**
 * Proof that this repo's coverage settings can actually FAIL.
 *
 * `vitest.config.spec.ts` asserts the settings are shaped correctly. This spec
 * asserts they WORK: it builds a throwaway project holding one covered module
 * and one module nothing imports, runs a real child `vitest --coverage` against
 * it with THIS repo's `include`/`exclude`/`thresholds`, and requires the run to
 * fail. The negative control below then deletes `include` and shows the same
 * project sailing through at 100% — which is precisely the regression cf1cce4
 * shipped, restated as an assertion instead of a comment.
 */
const REPO_ROOT = path.join(import.meta.dirname, '..');
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'vitest');

/** Generous: a cold child Vitest with coverage instrumentation is not fast. */
const CHILD_RUN_TIMEOUT_MS = 180_000;

/**
 * The fixture MUST live outside any `node_modules`. `@vitest/coverage-v8`
 * discards every V8 coverage result whose URL contains `/node_modules/`
 * (`filterResult` in its `dist/index.js`), so a fixture parked there reports
 * 0 files, 0 statements and an "Unknown%" total — it passes for the wrong
 * reason and proves nothing.
 *
 * A temp directory is therefore the right home, and it costs nothing: the
 * generated config below is a PLAIN OBJECT, not `defineConfig(...)`, so the
 * fixture imports nothing and needs no view of this repo's dependencies. Keep
 * it that way — adding an import to the fixture would need a `node_modules`
 * symlink to resolve.
 */
const makeFixtureDir = (): string => mkdtempSync(path.join(tmpdir(), 'coverage-gate-fixture-'));

interface CoverageSettings {
  include: readonly string[];
  exclude: readonly string[];
  thresholds: unknown;
}

/**
 * Read the REAL coverage settings out of `vitest.config.ts`. Deliberately not
 * hardcoded — the point of the fixture is to exercise whatever this repo
 * currently configures, so a change to the globs changes what is proven here.
 */
const realCoverageSettings = (): CoverageSettings => {
  const coverage = vitestConfig({ command: 'serve', mode: 'test' }).test?.coverage;
  const include = coverage?.include;
  const exclude = coverage?.exclude;
  const thresholds = coverage?.thresholds;

  if (include === undefined || exclude === undefined || thresholds === undefined) {
    throw new Error('vitest.config.ts is missing coverage include, exclude or thresholds');
  }

  return { include, exclude, thresholds };
};

const buildFixtureConfig = (options: { readonly withInclude: boolean }): string => {
  const { include, exclude, thresholds } = realCoverageSettings();

  return [
    'export default {',
    '  test: {',
    '    globals: true,',
    '    coverage: {',
    "      provider: 'v8',",
    '      enabled: true,',
    "      reporter: ['json-summary'],",
    ...(options.withInclude ? [`      include: ${JSON.stringify(include)},`] : []),
    `      exclude: ${JSON.stringify(exclude)},`,
    `      thresholds: ${JSON.stringify(thresholds)},`,
    '    },',
    '  },',
    '};',
    '',
  ].join('\n');
};

const writeFixtureConfig = (fixtureDir: string, options: { readonly withInclude: boolean }): void => {
  rmSync(path.join(fixtureDir, 'coverage'), { force: true, recursive: true });
  writeFileSync(path.join(fixtureDir, 'vitest.config.ts'), buildFixtureConfig(options));
};

/** A child process failure carries the exit code that `execFileSync` threw on. */
const exitStatusOf = (error: unknown): number => {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }

  throw error;
};

const runFixtureVitest = (fixtureDir: string): number => {
  // The parent Vitest exports these; leaving them set makes the child believe it
  // is a worker of this run and adopt the wrong pool identity.
  const env = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;

  try {
    execFileSync(VITEST_BIN, ['run', '--coverage', '--silent', '--pool=forks', '--maxWorkers=1'], {
      cwd: fixtureDir,
      encoding: 'utf-8',
      env,
      stdio: 'pipe',
    });

    return 0;
  } catch (error) {
    return exitStatusOf(error);
  }
};

interface SummaryEntry {
  statements: { pct: number };
}

type CoverageSummary = Record<string, SummaryEntry>;

const readFixtureSummary = (fixtureDir: string): CoverageSummary => {
  const raw: unknown = JSON.parse(readFileSync(path.join(fixtureDir, 'coverage', 'coverage-summary.json'), 'utf-8'));

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('The fixture produced no usable coverage-summary.json');
  }

  return raw as CoverageSummary;
};

const uncoveredEntry = (summary: CoverageSummary): SummaryEntry | undefined =>
  Object.entries(summary).find(([key]) => key.endsWith(path.join('src', 'uncovered.ts')))?.[1];

describe('the coverage gate against a real child run', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = makeFixtureDir();

    mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
    writeFileSync(
      path.join(fixtureDir, 'src', 'covered.ts'),
      'export const covered = (value: number): number => value * 2;\n'
    );
    writeFileSync(
      path.join(fixtureDir, 'src', 'covered.spec.ts'),
      [
        "import { covered } from './covered';",
        '',
        "it('doubles', () => {",
        '  expect(covered(2)).toBe(4);',
        '});',
        '',
      ].join('\n')
    );
    // Imported by nothing. Under `include` it must surface at 0%; without
    // `include` the v8 provider never hears about it.
    writeFileSync(
      path.join(fixtureDir, 'src', 'uncovered.ts'),
      'export const uncovered = (value: number): number => value + 1;\n'
    );
  });

  afterAll(() => {
    rmSync(fixtureDir, { force: true, recursive: true });
  });

  it(
    'fails the run and reports the unimported module at 0%',
    () => {
      writeFixtureConfig(fixtureDir, { withInclude: true });

      const status = runFixtureVitest(fixtureDir);
      const summary = readFixtureSummary(fixtureDir);

      // `toBe(1)`, not `not.toBe(0)`: vitest exits 1 when thresholds are unmet,
      // and a looser assertion would also be satisfied by the fixture failing
      // to build or the child crashing — which is exactly how an earlier
      // version of this spec passed while reporting 0/0 statements.
      expect(status).toBe(1);
      expect(uncoveredEntry(summary)?.statements.pct).toBe(0);
      expect(summary.total.statements.pct).toBeLessThan(100);
    },
    CHILD_RUN_TIMEOUT_MS
  );

  // NEGATIVE CONTROL — the same project, the same thresholds, `include` deleted.
  // This is cf1cce4: the unimported module vanishes from the report, the total
  // reads a perfect 100%, and the gate the run is supposed to enforce passes.
  // It is also what makes the assertion above meaningful — that run fails
  // because of `include` specifically, not because the fixture is broken.
  it(
    'passes at a false 100% once include is removed',
    () => {
      writeFixtureConfig(fixtureDir, { withInclude: false });

      const status = runFixtureVitest(fixtureDir);
      const summary = readFixtureSummary(fixtureDir);

      expect(status).toBe(0);
      expect(uncoveredEntry(summary)).toBeUndefined();
      expect(summary.total.statements.pct).toBe(100);
    },
    CHILD_RUN_TIMEOUT_MS
  );
});
