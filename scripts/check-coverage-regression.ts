#!/usr/bin/env tsx
/**
 * Coverage Regression Check Script
 *
 * Compares the current test coverage against the baseline stored in
 * COVERAGE_METRICS.md and fails if any metric has decreased beyond acceptable
 * limits. All policy, parsing and rendering lives in `./coverage-gate`; this
 * file is the shell that reads the files, prints the report, and picks the exit
 * code. Keep it that way — nothing here may be imported for its behaviour, and
 * nothing at module scope may touch the filesystem.
 *
 * Tolerance Policy:
 * - Allows up to 2% decrease in any metric
 * - ONLY if the metric remains above the configured threshold
 * - Thresholds are read from `coverage.thresholds` in vitest.config.ts, never
 *   duplicated here — see `parseThresholdsFromConfig`. The examples below
 *   assume the 95% that config currently sets.
 *
 * Examples (the parenthetical is the reason the gate reports):
 * - Statement coverage: 97% → 95.5% ✅ (within 2% tolerance, above 95% threshold)
 * - Statement coverage: 97% → 94.5% ❌ (below 95% threshold)
 * - Statement coverage: 100% → 97.5% ❌ (exceeds 2% tolerance)
 *
 * Usage: pnpm exec tsx scripts/check-coverage-regression.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareCoverage,
  type CoverageMetrics,
  formatComparison,
  hasImprovement,
  parseBaselineMetrics,
  parseCurrentCoverage,
  parseThresholdsFromConfig,
  refreshMetricsContent,
  type ReportLine,
} from './coverage-gate';

/** Read a required file, or explain what is missing and stop. */
const readOrExit = (filePath: string, ...missingHint: string[]): string => {
  if (!fs.existsSync(filePath)) {
    missingHint.forEach((line) => console.error(line));
    process.exit(1);
  }

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`❌ Failed to read ${path.basename(filePath)}. Please check file permissions and try again.`);
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  }
};

/** Run a parser, or report the reason it refused and stop. */
const parseOrExit = <T>(parse: () => T): T => {
  try {
    return parse();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

/** Print one report line on the channel it asked for. */
const emit = (line: ReportLine): void => {
  switch (line.level) {
    case 'info':
      console.info(line.text);
      break;
    case 'warn':
      console.warn(line.text);
      break;
    case 'error':
      console.error(line.text);
      break;
  }
};

/** Update COVERAGE_METRICS.md with new values if coverage improved. */
const updateMetricsFile = (metricsPath: string, current: CoverageMetrics): void => {
  const content = fs.readFileSync(metricsPath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];

  fs.writeFileSync(metricsPath, refreshMetricsContent(content, current, today));
  console.info(`📝 Updated COVERAGE_METRICS.md with new baseline (${today})\n`);
};

const main = (): void => {
  console.info('🔍 Checking for coverage regression...\n');

  const root = process.cwd();
  const metricsPath = path.join(root, 'COVERAGE_METRICS.md');
  const summaryPath = path.join(root, 'coverage', 'coverage-summary.json');

  const thresholds = parseOrExit(() =>
    parseThresholdsFromConfig(
      readOrExit(
        path.join(root, 'vitest.config.ts'),
        '❌ vitest.config.ts not found. Please ensure it exists at the project root.'
      )
    )
  );
  const baseline = parseOrExit(() =>
    parseBaselineMetrics(
      readOrExit(metricsPath, '❌ COVERAGE_METRICS.md not found. Please run tests first to establish a baseline.')
    )
  );
  const current = parseOrExit(() =>
    parseCurrentCoverage(
      readOrExit(summaryPath, '❌ coverage/coverage-summary.json not found.', 'Please run: pnpm run test:coverage')
    )
  );

  const comparison = compareCoverage({ baseline, current, thresholds });
  formatComparison(comparison).forEach(emit);

  if (comparison.passed && hasImprovement(baseline, current)) {
    updateMetricsFile(metricsPath, current);
  }

  process.exit(comparison.passed ? 0 : 1);
};

// True when this file is executed directly, not imported (ESM-safe require.main === module)
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
