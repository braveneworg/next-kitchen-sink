import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePct, parseThresholdsFromConfig, refreshMetricsContent } from './coverage-gate';

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

  // The whole point of the export: a generated project's seeded baseline must
  // be the same numbers the gate itself enforces.
  it('agrees with the real vitest.config.ts', () => {
    const actual = parseThresholdsFromConfig(readFileSync(join(process.cwd(), 'vitest.config.ts'), 'utf-8'));

    expect(actual.statements).toBeGreaterThan(0);
    expect(actual.branches).toBeGreaterThan(0);
    expect(actual.functions).toBeGreaterThan(0);
    expect(actual.lines).toBeGreaterThan(0);
  });
});
