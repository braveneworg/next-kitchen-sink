import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compareCoverage,
  effectiveFloor,
  evaluateMetric,
  hasImprovement,
  parseBaselineMetrics,
  parsePct,
  parseThresholdsFromConfig,
  refreshMetricsContent,
} from './coverage-gate';

const buildContent = (lastUpdatedLine: string): string =>
  [
    '# Coverage Metrics',
    '',
    '## Current Coverage Summary',
    '',
    '| Metric     | Coverage |',
    '| ---------- | -------- |',
    '| Statements | 98.98%   |',
    '| Branches   | 96.01%   |',
    '| Functions  | 99.17%   |',
    '| Lines      | 99.39%   |',
    '',
    lastUpdatedLine,
    '',
    '## Coverage History',
    '',
    '| Date       | Statements | Branches | Functions | Lines  | Notes       |',
    '| ---------- | ---------- | -------- | --------- | ------ | ----------- |',
    '| 2026-04-04 | 99.24%     | 96.13%   | 99.67%    | 99.44% | Improvement |',
  ].join('\n');

/**
 * The summary table plus a second table of exactly the `| Metric | NN% |`
 * shape in a later section. Reader and writer must both ignore the decoy.
 */
const buildContentWithDecoy = (): string =>
  [
    buildContent('**Last Updated:** 2026-07-04'),
    '',
    '## Coverage by package',
    '',
    '| Metric     | Coverage |',
    '| ---------- | -------- |',
    '| Statements | 11.11%   |',
    '| Branches   | 22.22%   |',
    '| Functions  | 33.33%   |',
    '| Lines      | 44.44%   |',
  ].join('\n');

describe('parsePct', () => {
  it('returns the value for a numeric percentage', () => {
    expect(parsePct(98.65, 'statements')).toBe(98.65);
  });

  it('returns 0 for a genuine zero percentage', () => {
    expect(parsePct(0, 'branches')).toBe(0);
  });

  // v8/istanbul emit the STRING "Unknown" whenever a metric's `total` is 0 —
  // i.e. the coverage include globs matched no files at all. Left unchecked it
  // reaches `.toFixed()` and throws an opaque TypeError deep in the comparison.
  it('throws a diagnostic error for the "Unknown" v8 sentinel', () => {
    expect(() => parsePct('Unknown', 'statements')).toThrowError(/statements/);
    expect(() => parsePct('Unknown', 'statements')).toThrowError(/no files were instrumented/i);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['a numeric string', '95'],
  ])('throws for %s', (_label, value) => {
    expect(() => parsePct(value, 'lines')).toThrowError(/lines/);
  });
});

describe('refreshMetricsContent', () => {
  const current = { statements: 98.65, branches: 95.31, functions: 98.85, lines: 99.13 };

  it('rewrites all four summary-table percentages', () => {
    const result = refreshMetricsContent(buildContent('**Last Updated:** 2026-07-04'), current, '2026-07-11');

    expect(result).toMatch(/\| Statements \| 98\.65%/);
    expect(result).toMatch(/\| Branches {3}\| 95\.31%/);
    expect(result).toMatch(/\| Functions {2}\| 98\.85%/);
    expect(result).toMatch(/\| Lines {6}\| 99\.13%/);
  });

  it('bumps an ISO-format Last Updated date', () => {
    const result = refreshMetricsContent(buildContent('**Last Updated:** 2026-07-04'), current, '2026-07-11');

    expect(result).toContain('**Last Updated:** 2026-07-11');
    expect(result).not.toContain('**Last Updated:** 2026-07-04');
  });

  it('bumps a legacy long-format Last Updated date', () => {
    const result = refreshMetricsContent(buildContent('**Last Updated:** July 4, 2026'), current, '2026-07-11');

    expect(result).toContain('**Last Updated:** 2026-07-11');
    expect(result).not.toContain('July 4, 2026');
  });

  it('does not touch the date line beyond its own line', () => {
    const result = refreshMetricsContent(buildContent('**Last Updated:** 2026-07-04'), current, '2026-07-11');

    expect(result).toContain('## Coverage History');
  });

  it('leaves Coverage History rows untouched', () => {
    const result = refreshMetricsContent(buildContent('**Last Updated:** 2026-07-04'), current, '2026-07-11');

    expect(result).toContain('| 2026-04-04 | 99.24%     | 96.13%   | 99.67%    | 99.44% | Improvement |');
  });

  // The writer edits the Current Coverage Summary section, nothing else. A
  // second table of the same shape elsewhere is somebody else's data.
  it('leaves a same-shaped table in a later section untouched', () => {
    const result = refreshMetricsContent(buildContentWithDecoy(), current, '2026-07-11');

    expect(result).toContain('| Statements | 11.11%   |');
    expect(result).toContain('| Lines      | 44.44%   |');
  });

  it('returns the whole document, not just the rewritten section', () => {
    const result = refreshMetricsContent(buildContentWithDecoy(), current, '2026-07-11');

    expect(result).toContain('# Coverage Metrics');
    expect(result).toContain('## Coverage History');
    expect(result).toContain('## Coverage by package');
  });

  it('throws when the summary heading is missing', () => {
    expect(() => refreshMetricsContent('# Coverage Metrics\n\nNothing here.', current, '2026-07-11')).toThrowError(
      /## Current Coverage Summary/
    );
  });
});

describe('parseBaselineMetrics', () => {
  it('reads the four summary percentages', () => {
    expect(parseBaselineMetrics(buildContent('**Last Updated:** 2026-07-04'))).toEqual({
      statements: 98.98,
      branches: 96.01,
      functions: 99.17,
      lines: 99.39,
    });
  });

  // Reader and writer are anchored to the same section by construction, so
  // they cannot disagree about which table is the baseline.
  it('reads the summary table, not a same-shaped table in a later section', () => {
    expect(parseBaselineMetrics(buildContentWithDecoy())).toEqual({
      statements: 98.98,
      branches: 96.01,
      functions: 99.17,
      lines: 99.39,
    });
  });

  it('throws when the summary heading is missing', () => {
    expect(() => parseBaselineMetrics('# Coverage Metrics\n\n| Statements | 98.98% |')).toThrowError(
      /## Current Coverage Summary/
    );
  });

  // The anchor is only useful if the real file keeps its shape. Values are not
  // asserted — the gate rewrites them — but the section must stay reachable.
  it('reads the real COVERAGE_METRICS.md', () => {
    const metricsPath = join(import.meta.dirname, '..', 'COVERAGE_METRICS.md');
    const baseline = parseBaselineMetrics(readFileSync(metricsPath, 'utf-8'));

    expect(Object.values(baseline).every((value) => Number.isFinite(value))).toBe(true);
  });

  it('throws naming what it did find when a row is absent', () => {
    const missing = ['## Current Coverage Summary', '', '| Statements | 98.98%   |', '', '## Coverage History'].join(
      '\n'
    );

    expect(() => parseBaselineMetrics(missing)).toThrowError(/branches|Could not parse all metrics/i);
  });
});

describe('parseThresholdsFromConfig', () => {
  const config = [
    'export default defineConfig({',
    '  test: {',
    '    coverage: {',
    '      thresholds: {',
    '        statements: 95,',
    '        branches: 85,',
    '        functions: 95.5,',
    '        lines: 95,',
    '      },',
    '    },',
    '  },',
    '});',
  ].join('\n');

  it('parses all four metrics, integer and decimal alike', () => {
    expect(parseThresholdsFromConfig(config)).toEqual({
      statements: 95,
      branches: 85,
      functions: 95.5,
      lines: 95,
    });
  });

  it('is order-independent', () => {
    const reordered = 'thresholds: { lines: 91, statements: 92, functions: 93, branches: 94 }';

    expect(parseThresholdsFromConfig(reordered)).toEqual({
      statements: 92,
      branches: 94,
      functions: 93,
      lines: 91,
    });
  });

  it('throws when the thresholds block is absent', () => {
    expect(() => parseThresholdsFromConfig('export default {}')).toThrowError(/thresholds block/i);
  });

  it('throws naming the metric that could not be parsed', () => {
    expect(() => parseThresholdsFromConfig('thresholds: { statements: 95, branches: 85, lines: 95 }')).toThrowError(
      /functions/
    );
  });

  // The config is read as TEXT, so a commented-out threshold is not a
  // threshold. Before the block was comment-stripped the `// lines: 90` below
  // won, and the gate silently enforced a number nobody had configured.
  it('ignores a metric that only appears in a line comment', () => {
    const commented = [
      'thresholds: {',
      '  // lines: 90 was the old value',
      '  statements: 95,',
      '  branches: 95,',
      '  functions: 95,',
      '  lines: 95,',
      '}',
    ].join('\n');

    expect(parseThresholdsFromConfig(commented)).toEqual({
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    });
  });

  it('ignores a whole thresholds block that is commented out', () => {
    const commented = [
      '/* An earlier draft:',
      ' * thresholds: { statements: 1, branches: 1, functions: 1, lines: 1 }',
      ' */',
      '// thresholds: { statements: 2, branches: 2, functions: 2, lines: 2 }',
      'thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 }',
    ].join('\n');

    expect(parseThresholdsFromConfig(commented)).toEqual({
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    });
  });

  // A non-greedy match to the FIRST `}` truncated the block at a nested
  // object, so the metrics that followed it looked absent.
  it('reads past a nested per-file object that opens the block', () => {
    const nested = 'thresholds: { perFile: { lines: 90 }, statements: 95, branches: 95, functions: 95, lines: 95 }';

    expect(parseThresholdsFromConfig(nested)).toEqual({
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    });
  });

  it('ignores a per-glob override that follows the four metrics', () => {
    const override =
      "thresholds: { statements: 95, branches: 95, functions: 95, lines: 95, 'src/utils/**': { lines: 100 } }";

    expect(parseThresholdsFromConfig(override)).toEqual({
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    });
  });

  // A text parser cannot resolve an identifier. Reporting "missing" would send
  // the reader hunting for a key that is right there — fail loudly instead.
  it('throws when a metric is a constant rather than a numeric literal', () => {
    const identifier = 'thresholds: { statements: STATEMENT_FLOOR, branches: 95, functions: 95, lines: 95 }';

    expect(() => parseThresholdsFromConfig(identifier)).toThrowError(/statements/);
    expect(() => parseThresholdsFromConfig(identifier)).toThrowError(/numeric literal/i);
  });

  it('throws when the block is assembled with a spread', () => {
    const spread = 'thresholds: { ...base, statements: 95, branches: 95, functions: 95, lines: 95 }';

    expect(() => parseThresholdsFromConfig(spread)).toThrowError(/spread/i);
  });

  it('throws when the block is never closed', () => {
    expect(() => parseThresholdsFromConfig('thresholds: { statements: 95,')).toThrowError(/thresholds block/i);
  });

  // The whole point of the export: a generated project's seeded baseline must
  // be the same numbers the gate itself enforces. Asserted as exact values, not
  // merely positive — a 95→5 typo has to fail here. Raising the bar in
  // vitest.config.ts is meant to fail this test, so the matching edit to
  // COVERAGE_METRICS.md's "Minimum" line cannot be forgotten.
  it('agrees with the real vitest.config.ts', () => {
    const configPath = join(import.meta.dirname, '..', 'vitest.config.ts');

    expect(parseThresholdsFromConfig(readFileSync(configPath, 'utf-8'))).toEqual({
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    });
  });
});

describe('effectiveFloor', () => {
  // COVERAGE_METRICS.md states the policy as max(baseline - 2, 95). Whichever
  // bound is higher governs, and it moves with the baseline.
  it.each([
    [100, 95, 98],
    [96, 95, 95],
    [95, 95, 95],
    [100, 90, 98],
    [91, 95, 95],
  ])('floors a baseline of %s against a threshold of %s at %s', (baseline, threshold, expected) => {
    expect(effectiveFloor(baseline, threshold)).toBe(expected);
  });
});

describe('evaluateMetric', () => {
  const THRESHOLD = 95;

  // The three worked examples in COVERAGE_METRICS.md, plus the one in
  // check-coverage-regression.ts's header. Asserting the MESSAGE, not just the
  // status: the two failure reasons are what an off-by-one silently swaps.
  it.each([
    [100, 98.5, '⚠️ OK', /within tolerance/],
    [97, 95.5, '⚠️ OK', /within tolerance/],
    [100, 97.5, '❌ FAIL', /exceeds 2% tolerance/],
    [97, 94.5, '❌ FAIL', /below threshold of 95%/],
  ])('classifies %s%% → %s%% as %s', (baseline, current, status, message) => {
    const result = evaluateMetric('statements', baseline, current, THRESHOLD);

    expect({ status, message: result.regression ?? result.toleratedDecrease ?? '' }).toEqual({
      status: result.status,
      message: expect.stringMatching(message),
    });
  });

  // Boundaries of max(baseline - 2, 95). Inclusive on both bounds.
  it.each([
    [100, 98.0, '⚠️ OK'],
    [100, 97.99, '❌ FAIL'],
    [96, 95.0, '⚠️ OK'],
    [96, 94.99, '❌ FAIL'],
  ])('treats %s%% → %s%% as %s', (baseline, current, status) => {
    expect(evaluateMetric('statements', baseline, current, THRESHOLD).status).toBe(status);
  });

  it.each([
    ['no change', 100, 100],
    ['an improvement', 100, 100.5],
    // This gate compares against the BASELINE, not the threshold. A baseline
    // already under the threshold passes here; Vitest's own coverage.thresholds
    // is what refuses it, and that runs first in test:coverage:check.
    ['a baseline already below the threshold', 94, 94],
  ])('passes %s without a message', (_label, baseline, current) => {
    expect(evaluateMetric('statements', baseline, current, THRESHOLD)).toEqual({ status: '✅' });
  });

  it('reports the threshold in preference to the tolerance when both are breached', () => {
    // Drop of 3 exceeds the tolerance AND lands under the floor. One message.
    expect(evaluateMetric('lines', 97, 94, THRESHOLD).regression).toMatch(/below threshold of 95%/);
  });

  // The refactor net: the branch structure is expressed via effectiveFloor, so
  // pin that it agrees with the original decrease/threshold formulation.
  it('agrees with the tolerance-and-threshold formulation across a grid', () => {
    const disagreements: string[] = [];

    for (let baseline = 90; baseline <= 100; baseline += 0.5) {
      for (let current = 88; current <= 101; current += 0.5) {
        const passed = evaluateMetric('statements', baseline, current, THRESHOLD).regression === undefined;
        const expected = current >= baseline || (baseline - current <= 2 && current >= THRESHOLD);

        if (passed !== expected) disagreements.push(`${baseline}→${current}`);
      }
    }

    expect(disagreements).toEqual([]);
  });
});

describe('compareCoverage', () => {
  const THRESHOLDS = { statements: 95, branches: 95, functions: 95, lines: 95 };
  const AT_100 = { statements: 100, branches: 100, functions: 100, lines: 100 };

  it('passes when nothing moved', () => {
    expect(compareCoverage({ baseline: AT_100, current: AT_100, thresholds: THRESHOLDS }).passed).toBe(true);
  });

  it('fails when one metric regresses beyond tolerance', () => {
    const current = { ...AT_100, branches: 97.5 };

    expect(compareCoverage({ baseline: AT_100, current, thresholds: THRESHOLDS }).regressions).toEqual([
      expect.stringMatching(/^Branches: .*exceeds 2% tolerance/),
    ]);
  });

  it('passes a tolerated decrease and still records it', () => {
    const current = { ...AT_100, lines: 98.5 };
    const result = compareCoverage({ baseline: AT_100, current, thresholds: THRESHOLDS });

    expect({ passed: result.passed, tolerated: result.toleratedDecreases.length }).toEqual({
      passed: true,
      tolerated: 1,
    });
  });

  it('reports one row per metric, in a stable order', () => {
    const rows = compareCoverage({ baseline: AT_100, current: AT_100, thresholds: THRESHOLDS }).rows;

    expect(rows.map((row) => row.metric)).toEqual(['statements', 'branches', 'functions', 'lines']);
  });
});

describe('hasImprovement', () => {
  const AT_100 = { statements: 100, branches: 100, functions: 100, lines: 100 };

  it('is false when every metric is unchanged', () => {
    expect(hasImprovement(AT_100, AT_100)).toBe(false);
  });

  it('is true when a single metric rose', () => {
    expect(hasImprovement({ ...AT_100, branches: 99 }, AT_100)).toBe(true);
  });

  it('is false when a metric only fell', () => {
    expect(hasImprovement(AT_100, { ...AT_100, branches: 99 })).toBe(false);
  });
});
