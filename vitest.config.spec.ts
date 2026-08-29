import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ViteUserConfig } from 'vitest/config';

import { parseThresholdsFromConfig } from './scripts/coverage-gate';
import vitestConfig from './vitest.config';

/**
 * The coverage gate has two halves that must agree: the `coverage` block Vitest
 * actually resolves, and the TEXT of this same file that `scripts/coverage-gate.ts`
 * greps for the four thresholds. This spec imports the config as a MODULE — so
 * every assertion below is about the object Vitest really runs with, not a
 * string that happens to look right.
 */
const REPO_ROOT = import.meta.dirname;

type CoverageOptions = NonNullable<NonNullable<ViteUserConfig['test']>['coverage']>;

const resolveCoverage = (): CoverageOptions => {
  const coverage = vitestConfig({ command: 'serve', mode: 'test' }).test?.coverage;

  if (coverage === undefined) {
    throw new Error('vitest.config.ts resolved with no test.coverage block');
  }

  return coverage;
};

const resolveExclude = (): readonly string[] => {
  const { exclude } = resolveCoverage();

  if (exclude === undefined) {
    throw new Error('vitest.config.ts resolved with no coverage.exclude array');
  }

  return exclude;
};

const resolveInclude = (): readonly string[] => {
  const { include } = resolveCoverage();

  if (include === undefined) {
    throw new Error('vitest.config.ts resolved with no coverage.include array');
  }

  return include;
};

/**
 * The set of files the coverage report actually measures: `coverage.include`
 * minus `coverage.exclude`, resolved against the real working tree.
 */
const measuredFiles = (exclude: readonly string[]): readonly string[] =>
  globSync([...resolveInclude()], { cwd: REPO_ROOT, exclude: [...exclude] }).sort();

describe('coverage.thresholds', () => {
  // Exact values, not `toBeGreaterThanOrEqual`. RAISING THE BAR IS MEANT TO FAIL
  // THIS TEST: the number lives in three places — here, in `COVERAGE_METRICS.md`,
  // and in the prose of the docs — and a green suite after a one-sided bump is
  // how those drift apart. Failing here is the reminder to edit the others.
  it('is 95 on all four metrics', () => {
    expect(resolveCoverage().thresholds).toEqual({
      lines: 95,
      functions: 95,
      branches: 95,
      statements: 95,
    });
  });

  // The real invariant. `scripts/coverage-gate.ts` never imports this config; it
  // reads the file as TEXT and regexes the four numbers out of it. A refactor
  // that keeps the object valid but breaks the parse — a nested object, a spread,
  // a shared constant — leaves the gate enforcing whatever it last managed to
  // read. This is the only assertion that runs both halves against each other.
  it('is read identically by the text parser and by Vitest', () => {
    const fromText = parseThresholdsFromConfig(readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf-8'));

    expect(fromText).toEqual(resolveCoverage().thresholds);
  });
});

describe('coverage.include', () => {
  // Load-bearing, and it has been deleted once already (cf1cce4). WITHOUT it the
  // v8 provider reports only the files a test loaded, so an untested module is
  // ABSENT from the report rather than counted as 0% — and every threshold above
  // becomes unfailable. `scripts/coverage-gate-fixture.spec.ts` proves that
  // failure mode end-to-end against a real child `vitest --coverage`.
  it('names the first-party source set', () => {
    expect(resolveInclude()).toEqual(['src/**/*.{ts,tsx}']);
  });
});

describe('coverage.exclude', () => {
  it('has no duplicate entries', () => {
    const exclude = resolveExclude();
    const duplicates = exclude.filter((entry, index) => exclude.indexOf(entry) !== index);

    expect(duplicates).toEqual([]);
  });

  /**
   * Globs that match nothing in the tree today and are kept anyway, because the
   * thing they guard against is a file someone is likely to add tomorrow.
   * Anything NOT listed here has to earn its place by removing a real file.
   */
  const GUARD_GLOBS: ReadonlySet<string> = new Set([
    // `src/**/*.{ts,tsx}` matches a `.d.ts`, and an ambient declaration has no
    // executable statements to cover — it would land in the report as an
    // unfixable 0%.
    '**/*.d.ts',
    // `src/types/**` is where type-only modules go. Same reasoning as above,
    // pre-empted for the directory rather than the extension.
    '**/types/**',
  ]);

  // `coverage.include` is `src/**/*.{ts,tsx}` and Vitest 4's
  // `coverageConfigDefaults.exclude` is `[]`, so nothing is inherited: an entry
  // that cannot match a `.ts`/`.tsx` file under `src/` excludes nothing from
  // anything. Such entries read as protection that isn't there.
  it('contains no entry that neither removes a file nor guards a future one', () => {
    const include = [...resolveInclude()];
    const everySourceFile = globSync(include, { cwd: REPO_ROOT });

    const inert = resolveExclude().filter((entry) => {
      if (GUARD_GLOBS.has(entry)) {
        return false;
      }

      return globSync(include, { cwd: REPO_ROOT, exclude: [entry] }).length === everySourceFile.length;
    });

    expect(inert).toEqual([]);
  });
});

describe('the measured source set', () => {
  // Pinned deliberately. Adding a source file under `src/` puts it here, and a
  // new file with no spec drags the headline number down — that should be a
  // visible edit to this list, made on purpose, not a silent coverage drop
  // discovered in CI.
  it('is exactly the three first-party modules with specs', () => {
    expect(measuredFiles(resolveExclude())).toEqual([
      'src/app/page.tsx',
      'src/hooks/use-mobile.ts',
      'src/lib/utils.ts',
    ]);
  });
});
