/**
 * Coverage gate — policy, parsing and rendering. No IO, ever.
 *
 * This module deliberately imports nothing from `node:fs`, `node:path` or
 * `process`. Everything it does is text in / data out, so importing it cannot
 * read a file, cannot depend on the working directory, and cannot end the host
 * process. `scripts/check-coverage-regression.ts` is the shell that supplies
 * the strings and turns the result into console output and an exit code;
 * `scripts/init-from-template.ts` reuses the parser and the rewriter.
 *
 * Two gates guard coverage and they do different jobs. Vitest's own
 * `coverage.thresholds` enforces the FLOOR and runs first. This module
 * enforces the DELTA against the baseline recorded in COVERAGE_METRICS.md.
 * That division is why `coverage.include` is load-bearing: without it the v8
 * provider omits unloaded files and the floor gate cannot fail.
 */

/** The four percentages every coverage figure in this repo is expressed as. */
export interface CoverageMetrics {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

/** Percentage points a metric may fall below the baseline before the gate objects. */
export const ALLOWED_DECREASE_TOLERANCE = 2;

/** The classification of a single metric's baseline→current change. */
export interface MetricEvaluation {
  /** Status cell rendered in the comparison table. */
  status: string;
  /** A regression message, when the change is a hard failure. */
  regression?: string;
  /** A tolerated-decrease message, when the change is within tolerance. */
  toleratedDecrease?: string;
}

/** One row of the comparison table, with the classification that produced it. */
export interface MetricComparison extends MetricEvaluation {
  metric: keyof CoverageMetrics;
  baseline: number;
  current: number;
  threshold: number;
  diff: number;
}

/** The whole baseline→current comparison, including the pass/fail verdict. */
export interface CoverageComparison {
  rows: readonly MetricComparison[];
  regressions: readonly string[];
  toleratedDecreases: readonly string[];
  passed: boolean;
}

/** A line of report output, tagged with the console channel it belongs on. */
export interface ReportLine {
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** The metrics in the order every table and message renders them. */
const METRIC_NAMES: readonly (keyof CoverageMetrics)[] = ['statements', 'branches', 'functions', 'lines'];

/** Literal property access for a fixed-shape metric, avoiding computed key indexing. */
export const readMetric = (source: CoverageMetrics, metric: keyof CoverageMetrics): number => {
  switch (metric) {
    case 'statements':
      return source.statements;
    case 'branches':
      return source.branches;
    case 'functions':
      return source.functions;
    case 'lines':
      return source.lines;
  }
};

/**
 * Parse the four coverage thresholds out of a `vitest.config.ts` source string.
 *
 * Reads the config as TEXT, so the block must stay literal: four numeric
 * literals, no nested object, no constant or spread. See the note beside
 * `coverage.thresholds` in vitest.config.ts.
 *
 * @param configContent The full text of `vitest.config.ts`.
 * @returns The parsed thresholds.
 * @throws If the thresholds block or any individual metric is missing/unparseable.
 */
export const parseThresholdsFromConfig = (configContent: string): CoverageMetrics => {
  // Parse the thresholds block from the config file in an order-independent way.
  // Supports integer and decimal threshold values, e.g. 95 or 95.5.
  const thresholdsBlockMatch = configContent.match(/thresholds\s*:\s*\{([\s\S]*?)\}/);

  if (!thresholdsBlockMatch) {
    throw new Error('Could not find coverage thresholds block in vitest.config.ts');
  }

  const thresholdsBlock = thresholdsBlockMatch[1];
  // Static per-metric regexes (literals) keyed by metric name. Equivalent to the
  // previously dynamic `new RegExp(\`\\b${key}\\s*:...\`)` but without a non-literal RegExp.
  const metricRegexes = new Map<keyof CoverageMetrics, RegExp>([
    ['lines', /\blines\s*:\s*(\d+\.?\d*)/],
    ['functions', /\bfunctions\s*:\s*(\d+\.?\d*)/],
    ['branches', /\bbranches\s*:\s*(\d+\.?\d*)/],
    ['statements', /\bstatements\s*:\s*(\d+\.?\d*)/],
  ]);
  const parsedThresholds = new Map<keyof CoverageMetrics, number>();

  for (const [key, keyRegex] of metricRegexes) {
    const match = thresholdsBlock.match(keyRegex);

    if (!match) {
      throw new Error(`Could not parse "${key}" coverage threshold from vitest.config.ts`);
    }

    const value = parseFloat(match[1]);

    if (Number.isNaN(value)) {
      throw new Error(`Parsed "${key}" coverage threshold is not a valid number in vitest.config.ts`);
    }

    parsedThresholds.set(key, value);
  }

  const readParsed = (key: keyof CoverageMetrics): number => {
    const value = parsedThresholds.get(key);
    if (value === undefined) {
      throw new Error(`Missing "${key}" coverage threshold in vitest.config.ts`);
    }
    return value;
  };

  return {
    statements: readParsed('statements'),
    branches: readParsed('branches'),
    functions: readParsed('functions'),
    lines: readParsed('lines'),
  };
};

/**
 * Parse the baseline percentages out of COVERAGE_METRICS.md.
 *
 * @param metricsContent The full text of COVERAGE_METRICS.md.
 * @returns The baseline metrics.
 * @throws If any of the four rows is missing.
 */
export const parseBaselineMetrics = (metricsContent: string): CoverageMetrics => {
  // Format: | Statements | 98.47%   |
  const metricsRegex = /\|\s*(Statements|Branches|Functions|Lines)\s*\|\s*(\d+\.?\d*)%\s*\|/gi;
  const metrics = new Map<keyof CoverageMetrics, number>();

  let match;
  while ((match = metricsRegex.exec(metricsContent)) !== null) {
    const metricName = match[1].toLowerCase() as keyof CoverageMetrics;
    metrics.set(metricName, parseFloat(match[2]));
  }

  const statements = metrics.get('statements');
  const branches = metrics.get('branches');
  const functions = metrics.get('functions');
  const lines = metrics.get('lines');

  if (statements === undefined || branches === undefined || functions === undefined || lines === undefined) {
    throw new Error(
      `Could not parse all metrics from COVERAGE_METRICS.md. Found: ${JSON.stringify(Object.fromEntries(metrics))}`
    );
  }

  return { statements, branches, functions, lines };
};

/**
 * Coerce one `pct` field from coverage-summary.json into a number.
 *
 * `JSON.parse` hands back `any`, so nothing type-checks these fields. v8 and
 * istanbul emit the STRING `"Unknown"` for any metric whose `total` is 0 —
 * which happens when the coverage `include` globs match no files. Left
 * unvalidated it flows all the way to `.toFixed()` and throws an opaque
 * `TypeError: currentValue.toFixed is not a function`. Fail here, with the
 * metric named and the likely cause spelled out.
 *
 * @param raw   The `pct` value as parsed from JSON — trusted to be nothing.
 * @param metric Metric name, used to make the error message actionable.
 * @returns The percentage as a finite number.
 * @throws If `raw` is not a finite number.
 */
export const parsePct = (raw: unknown, metric: string): number => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }

  if (raw === 'Unknown') {
    throw new Error(
      `${metric}: coverage reported "Unknown" — no files were instrumented (total is 0). ` +
        'Check the coverage `include`/`exclude` globs in vitest.config.ts, and that the suite ' +
        'actually imports the files you expect to measure.'
    );
  }

  throw new Error(`${metric}: expected a numeric percentage, got ${JSON.stringify(raw)}.`);
};

/** The `total` block of a coverage-summary.json, before any field is trusted. */
interface CoverageSummaryTotals {
  statements?: { pct?: unknown };
  branches?: { pct?: unknown };
  functions?: { pct?: unknown };
  lines?: { pct?: unknown };
}

/**
 * Parse the `total` percentages out of a coverage-summary.json document.
 *
 * @param summaryJson The full text of coverage/coverage-summary.json.
 * @returns The current metrics.
 * @throws If the document is unparseable, has no `total`, or carries a non-numeric `pct`.
 */
export const parseCurrentCoverage = (summaryJson: string): CoverageMetrics => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(summaryJson);
  } catch (error) {
    throw new Error(`Could not parse coverage-summary.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const total = (parsed as { total?: CoverageSummaryTotals } | null)?.total;

  if (!total) {
    throw new Error('No total coverage found in coverage-summary.json');
  }

  return {
    statements: parsePct(total.statements?.pct, 'statements'),
    branches: parsePct(total.branches?.pct, 'branches'),
    functions: parsePct(total.functions?.pct, 'functions'),
    lines: parsePct(total.lines?.pct, 'lines'),
  };
};

/**
 * The lowest value a metric may take without failing the gate.
 *
 * Both bounds apply, so whichever binds first governs — this is the
 * `max(baseline - tolerance, threshold)` formula COVERAGE_METRICS.md states.
 */
export const effectiveFloor = (baselineValue: number, threshold: number): number =>
  Math.max(baselineValue - ALLOWED_DECREASE_TOLERANCE, threshold);

/**
 * Classify one metric's change into a table status plus, where relevant, a
 * regression or tolerated-decrease message.
 *
 * Note this is a DELTA gate: any value at or above the baseline passes, however
 * low the baseline is. The absolute floor is Vitest's own `coverage.thresholds`.
 */
export const evaluateMetric = (
  metric: keyof CoverageMetrics,
  baselineValue: number,
  currentValue: number,
  threshold: number
): MetricEvaluation => {
  if (currentValue >= baselineValue) {
    return { status: '✅' };
  }

  const diff = currentValue - baselineValue;
  const label = metric.charAt(0).toUpperCase() + metric.slice(1);
  const change = `${baselineValue.toFixed(2)}% → ${currentValue.toFixed(2)}% (${diff.toFixed(2)}%`;

  if (currentValue >= effectiveFloor(baselineValue, threshold)) {
    return {
      status: '⚠️ OK',
      toleratedDecrease: `${label}: ${change}, within tolerance)`,
    };
  }

  // Which bound bit? The threshold is reported in preference to the tolerance,
  // so a drop that breaches both is described by the absolute floor.
  if (currentValue < threshold) {
    return {
      status: '❌ FAIL',
      regression: `${label}: ${change}, below threshold of ${threshold}%)`,
    };
  }

  return {
    status: '❌ FAIL',
    regression: `${label}: ${change}, exceeds ${ALLOWED_DECREASE_TOLERANCE}% tolerance)`,
  };
};

/** Compare a coverage run against the baseline under the given thresholds. */
export const compareCoverage = (input: {
  baseline: CoverageMetrics;
  current: CoverageMetrics;
  thresholds: CoverageMetrics;
}): CoverageComparison => {
  const { baseline, current, thresholds } = input;
  const rows: MetricComparison[] = [];
  const regressions: string[] = [];
  const toleratedDecreases: string[] = [];

  for (const metric of METRIC_NAMES) {
    const baselineValue = readMetric(baseline, metric);
    const currentValue = readMetric(current, metric);
    const threshold = readMetric(thresholds, metric);
    const evaluation = evaluateMetric(metric, baselineValue, currentValue, threshold);

    if (evaluation.regression) regressions.push(evaluation.regression);
    if (evaluation.toleratedDecrease) toleratedDecreases.push(evaluation.toleratedDecrease);

    rows.push({
      ...evaluation,
      metric,
      baseline: baselineValue,
      current: currentValue,
      threshold,
      diff: currentValue - baselineValue,
    });
  }

  return { rows, regressions, toleratedDecreases, passed: regressions.length === 0 };
};

/** True when any metric rose above the baseline. */
export const hasImprovement = (baseline: CoverageMetrics, current: CoverageMetrics): boolean =>
  METRIC_NAMES.some((metric) => readMetric(current, metric) > readMetric(baseline, metric));

/** Render the comparison table rows. */
const formatTable = (rows: readonly MetricComparison[]): ReportLine[] => {
  const lines: ReportLine[] = [
    { level: 'info', text: '\n📊 Coverage Comparison\n' },
    { level: 'info', text: '| Metric     | Baseline | Current  | Change   | Status |' },
    { level: 'info', text: '|------------|----------|----------|----------|--------|' },
  ];

  for (const row of rows) {
    const diffStr = row.diff >= 0 ? `+${row.diff.toFixed(2)}%` : `${row.diff.toFixed(2)}%`;
    const arrowStatus = row.diff < 0 ? '⬇️' : row.diff > 0 ? '⬆️' : '➡️';
    const metricDisplay = row.metric.charAt(0).toUpperCase() + row.metric.slice(1);

    lines.push({
      level: 'info',
      text:
        `| ${metricDisplay.padEnd(10)} | ${row.baseline.toFixed(2).padStart(6)}%  | ` +
        `${row.current.toFixed(2).padStart(6)}%  | ${arrowStatus} ${diffStr.padStart(6)} | ${row.status.padEnd(6)} |`,
    });
  }

  lines.push({ level: 'info', text: '' });
  return lines;
};

/** Render the tolerated-decrease and regression summaries, and the verdict. */
const formatSummary = (comparison: CoverageComparison): ReportLine[] => {
  const lines: ReportLine[] = [];
  const { regressions, toleratedDecreases } = comparison;

  if (toleratedDecreases.length > 0) {
    lines.push({ level: 'warn', text: '⚠️  Coverage decreased within acceptable tolerance:\n' });
    toleratedDecreases.forEach((d) => lines.push({ level: 'warn', text: `  • ${d}` }));
    lines.push({
      level: 'warn',
      text: `\nNote: Up to ${ALLOWED_DECREASE_TOLERANCE}% decrease is permitted as long as thresholds are met.\n`,
    });
  }

  if (regressions.length > 0) {
    lines.push({ level: 'error', text: '❌ Coverage regression detected!\n' });
    lines.push({ level: 'error', text: 'The following metrics have decreased beyond acceptable limits:\n' });
    regressions.forEach((r) => lines.push({ level: 'error', text: `  • ${r}` }));
    lines.push({ level: 'error', text: '\nPlease add tests to maintain or improve coverage before merging.' });
    lines.push({
      level: 'error',
      text: 'If the decrease is intentional, update COVERAGE_METRICS.md with the new baseline.\n',
    });
    return lines;
  }

  lines.push({
    level: 'info',
    text:
      toleratedDecreases.length === 0
        ? '✅ No coverage regression detected!\n'
        : '✅ Coverage changes are within acceptable limits (no regressions beyond tolerance)!\n',
  });
  return lines;
};

/** Render a comparison as console-ready lines, tagged with their channel. */
export const formatComparison = (comparison: CoverageComparison): readonly ReportLine[] => [
  ...formatTable(comparison.rows),
  ...formatSummary(comparison),
];

/**
 * Rewrite the Current Coverage Summary percentages and the Last Updated date
 * in the metrics file content. Only the first occurrence of each metric row is
 * replaced, which is the summary table; Coverage History rows are never touched
 * (their cells don't follow a metric label).
 */
export const refreshMetricsContent = (content: string, current: CoverageMetrics, today: string): string =>
  content
    .replace(/(\|\s*Statements\s*\|\s*)\d+\.?\d*%/, `$1${current.statements.toFixed(2)}%`)
    .replace(/(\|\s*Branches\s*\|\s*)\d+\.?\d*%/, `$1${current.branches.toFixed(2)}%`)
    .replace(/(\|\s*Functions\s*\|\s*)\d+\.?\d*%/, `$1${current.functions.toFixed(2)}%`)
    .replace(/(\|\s*Lines\s*\|\s*)\d+\.?\d*%/, `$1${current.lines.toFixed(2)}%`)
    // Match the whole rest of the line — the file carries ISO dates, and the
    // previous "July 4, 2026"-style pattern silently skipped them, leaving
    // stale dates behind refreshed percentages.
    .replace(/\*\*Last Updated:\*\*.*$/m, `**Last Updated:** ${today}`);
