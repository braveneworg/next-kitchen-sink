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

/** The characters that open a string literal in TypeScript source. */
const STRING_DELIMITERS = new Set(["'", '"', '`']);

/**
 * Index just past the string literal that opens at `openIndex`.
 *
 * Backslash escapes are skipped whole, so an escaped quote does not close the
 * literal. An unterminated literal consumes the rest of the source.
 */
const endOfStringLiteral = (source: string, openIndex: number): number => {
  // charAt, not [], throughout this module: bracket indexing a string trips
  // oxlint's security/detect-object-injection, and charAt is equivalent here
  // (both yield '' past the end, which matches nothing).
  const quote = source.charAt(openIndex);
  let index = openIndex + 1;

  while (index < source.length) {
    if (source.charAt(index) === '\\') {
      index += 2;
      continue;
    }
    if (source.charAt(index) === quote) {
      return index + 1;
    }
    index += 1;
  }

  return source.length;
};

/**
 * Blank out `//` and block comments, preserving every other character's offset.
 *
 * Comment bodies become spaces (newlines are kept) so that a commented-out
 * `thresholds: {` or `lines: 90` cannot be mistaken for configuration, while
 * indexes into the result still address the original source. String literals
 * are skipped so a `//` inside one survives. Regex literals are NOT tracked —
 * `vitest.config.ts` has none, and one containing a quote would be misread.
 */
const stripComments = (source: string): string => {
  let result = '';
  let index = 0;

  while (index < source.length) {
    const char = source.charAt(index);

    if (STRING_DELIMITERS.has(char)) {
      const end = endOfStringLiteral(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }

    if (char === '/' && source.charAt(index + 1) === '/') {
      const newline = source.indexOf('\n', index);
      const end = newline === -1 ? source.length : newline;
      result += ' '.repeat(end - index);
      index = end;
      continue;
    }

    if (char === '/' && source.charAt(index + 1) === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      result += source.slice(index, end).replace(/[^\n]/g, ' ');
      index = end;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
};

/**
 * Index of the `}` that closes the `{` at `openIndex`, or -1 if it is never
 * closed. Braces inside string literals are ignored.
 */
const indexOfMatchingBrace = (source: string, openIndex: number): number => {
  let depth = 0;
  let index = openIndex;

  while (index < source.length) {
    const char = source.charAt(index);

    if (STRING_DELIMITERS.has(char)) {
      index = endOfStringLiteral(source, index);
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }

    index += 1;
  }

  return -1;
};

/**
 * Remove every nested `{ … }` group from an object-literal body, leaving only
 * its top-level text. This is what stops a `perFile: { lines: 90 }` sub-block
 * or a `'src/**': { lines: 100 }` per-glob override from supplying a metric.
 */
const stripNestedBlocks = (body: string): string => {
  let result = '';
  let index = 0;

  while (index < body.length) {
    const char = body.charAt(index);

    if (STRING_DELIMITERS.has(char)) {
      const end = endOfStringLiteral(body, index);
      result += body.slice(index, end);
      index = end;
      continue;
    }

    if (char === '{') {
      const close = indexOfMatchingBrace(body, index);
      index = close === -1 ? body.length : close + 1;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
};

/** A threshold value this parser can resolve: an integer or decimal literal. */
const NUMERIC_LITERAL = /^\d+\.?\d*$/;

/**
 * Static per-metric patterns. The value is captured up to the next separator
 * rather than as digits, so a non-numeric value is reported as such instead of
 * looking like a missing key.
 */
const METRIC_PATTERNS: readonly (readonly [keyof CoverageMetrics, RegExp])[] = [
  ['statements', /\bstatements\s*:\s*([^,\n]*)/],
  ['branches', /\bbranches\s*:\s*([^,\n]*)/],
  ['functions', /\bfunctions\s*:\s*([^,\n]*)/],
  ['lines', /\blines\s*:\s*([^,\n]*)/],
];

/**
 * Parse the four coverage thresholds out of a `vitest.config.ts` source string.
 *
 * The config is read as TEXT, never evaluated, so the contract is narrow and
 * enforced rather than assumed:
 *
 * - Comments are stripped first. A `// lines: 90` or a commented-out
 *   `thresholds: {` block is not configuration and cannot win.
 * - The block is taken as a BRACE-BALANCED slice of the first real
 *   `thresholds: { … }`, so it can be read past a nested object.
 * - Nested `{ … }` groups inside it are discarded before the metrics are
 *   matched, so `perFile` and per-glob overrides never supply a value.
 * - Each of `statements`, `branches`, `functions` and `lines` must appear once
 *   at the top level of that block with an integer or decimal LITERAL. An
 *   identifier, expression or spread throws — it cannot be resolved from text,
 *   and reporting it as "missing" would send the reader hunting for a key that
 *   is plainly there.
 *
 * Order is irrelevant.
 *
 * @param configContent The full text of `vitest.config.ts`.
 * @returns The parsed thresholds.
 * @throws If the thresholds block is missing or unterminated, if it uses a
 *   spread, or if any metric is missing or is not a numeric literal.
 */
export const parseThresholdsFromConfig = (configContent: string): CoverageMetrics => {
  const source = stripComments(configContent);
  const keyMatch = source.match(/\bthresholds\s*:\s*\{/);

  if (!keyMatch || keyMatch.index === undefined) {
    throw new Error('Could not find coverage thresholds block in vitest.config.ts');
  }

  const openIndex = keyMatch.index + keyMatch[0].length - 1;
  const closeIndex = indexOfMatchingBrace(source, openIndex);

  if (closeIndex === -1) {
    throw new Error('The coverage thresholds block in vitest.config.ts is never closed — no matching `}` was found.');
  }

  const thresholdsBlock = stripNestedBlocks(source.slice(openIndex + 1, closeIndex));

  if (thresholdsBlock.includes('...')) {
    throw new Error(
      'The coverage thresholds block in vitest.config.ts uses a spread, which cannot be resolved from ' +
        'the config text. List statements, branches, functions and lines as numeric literals.'
    );
  }

  const parsedThresholds = new Map<keyof CoverageMetrics, number>();

  for (const [key, keyRegex] of METRIC_PATTERNS) {
    const match = thresholdsBlock.match(keyRegex);

    if (!match) {
      throw new Error(`Could not parse "${key}" coverage threshold from vitest.config.ts`);
    }

    const literal = match[1].trim();

    if (!NUMERIC_LITERAL.test(literal)) {
      throw new Error(
        `The "${key}" coverage threshold in vitest.config.ts must be a numeric literal, but reads \`${literal}\`. ` +
          'The gate parses the config as text and cannot resolve identifiers or expressions.'
      );
    }

    parsedThresholds.set(key, parseFloat(literal));
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

/** The COVERAGE_METRICS.md heading that both the reader and the writer anchor to. */
const SUMMARY_HEADING = '## Current Coverage Summary';

/** A COVERAGE_METRICS.md document split around its Current Coverage Summary section. */
interface SummarySplit {
  /** Everything before the summary heading. */
  before: string;
  /** The heading and its body, up to (not including) the next `##` heading. */
  section: string;
  /** Everything from the next `##` heading onwards. */
  after: string;
}

/**
 * Split COVERAGE_METRICS.md around its Current Coverage Summary section.
 *
 * The section runs from the `## Current Coverage Summary` heading to the next
 * `## ` heading, or to the end of the document. Both the baseline reader and
 * the baseline writer work on this slice and nothing else, so they cannot
 * disagree about which table is the baseline — a second table of the same
 * `| Metric | NN% |` shape elsewhere in the file is simply out of scope. The
 * `**Last Updated:**` line lives inside this section, so the writer's date
 * stamp is in scope.
 *
 * @param content The full text of COVERAGE_METRICS.md.
 * @returns The document in three parts.
 * @throws If the summary heading is absent.
 */
const splitSummarySection = (content: string): SummarySplit => {
  const headingMatch = content.match(/^##[^\S\n]+Current Coverage Summary[^\S\n]*$/m);

  if (!headingMatch || headingMatch.index === undefined) {
    throw new Error(`Could not find the "${SUMMARY_HEADING}" heading in COVERAGE_METRICS.md`);
  }

  const bodyStart = headingMatch.index + headingMatch[0].length;
  // `##` only — a `###` subheading stays inside the section.
  const nextHeadingMatch = content.slice(bodyStart).match(/^##[^\S\n#]/m);
  const sectionEnd = nextHeadingMatch?.index === undefined ? content.length : bodyStart + nextHeadingMatch.index;

  return {
    before: content.slice(0, headingMatch.index),
    section: content.slice(headingMatch.index, sectionEnd),
    after: content.slice(sectionEnd),
  };
};

/**
 * Parse the baseline percentages out of COVERAGE_METRICS.md.
 *
 * Only the Current Coverage Summary section is read — see
 * `splitSummarySection`.
 *
 * @param metricsContent The full text of COVERAGE_METRICS.md.
 * @returns The baseline metrics.
 * @throws If the summary heading or any of the four rows is missing.
 */
export const parseBaselineMetrics = (metricsContent: string): CoverageMetrics => {
  // Format: | Statements | 98.47%   |
  const metricsRegex = /\|\s*(Statements|Branches|Functions|Lines)\s*\|\s*(\d+\.?\d*)%\s*\|/gi;
  const metrics = new Map<keyof CoverageMetrics, number>();
  const { section } = splitSummarySection(metricsContent);

  let match;
  while ((match = metricsRegex.exec(section)) !== null) {
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
 * A Coverage History row — the only rows in COVERAGE_METRICS.md that open with
 * an ISO date.
 *
 * Exported so the writer, the reader and the tests share ONE definition. The
 * initialiser detected these rows with `\s*`-tolerant whitespace while its spec
 * re-derived the same rule with literal single spaces, so implementation and
 * test disagreed about what a history row was: a table Prettier had not yet
 * aligned matched one and not the other.
 */
const HISTORY_ROW = /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/;

export const isHistoryRow = (line: string): boolean => HISTORY_ROW.test(line);

/**
 * Build one Coverage History row.
 *
 * Deliberately unpadded. The previous version hand-counted alignment with
 * `' '.repeat(4)` / `(2)` / `(3)`, magic numbers tied to the header widths that
 * nothing checked and that silently rot when a column is renamed. Prettier
 * formats Markdown tables, and every writer of this file runs it, so column
 * alignment is not this function's problem.
 */
export const formatHistoryRow = (date: string, metrics: CoverageMetrics, note: string): string =>
  `| ${date} | ${metrics.statements.toFixed(2)}% | ${metrics.branches.toFixed(2)}% | ` +
  `${metrics.functions.toFixed(2)}% | ${metrics.lines.toFixed(2)}% | ${note} |`;

/**
 * Rewrite the Current Coverage Summary percentages and the Last Updated date,
 * returning the whole document with only that section changed.
 *
 * Scoped to the same slice `parseBaselineMetrics` reads, so the writer can
 * never target a different table than the reader — see `splitSummarySection`.
 * Coverage History rows survive on two counts: they sit in a later section,
 * and their cells don't follow a metric label.
 *
 * @param content The full text of COVERAGE_METRICS.md.
 * @param current The percentages to write in.
 * @param today ISO date (YYYY-MM-DD) to stamp on the Last Updated line.
 * @returns The full document, with the summary section rewritten.
 * @throws If the summary heading is absent.
 */
export const refreshMetricsContent = (content: string, current: CoverageMetrics, today: string): string => {
  const { before, section, after } = splitSummarySection(content);

  const refreshed = section
    .replace(/(\|\s*Statements\s*\|\s*)\d+\.?\d*%/, `$1${current.statements.toFixed(2)}%`)
    .replace(/(\|\s*Branches\s*\|\s*)\d+\.?\d*%/, `$1${current.branches.toFixed(2)}%`)
    .replace(/(\|\s*Functions\s*\|\s*)\d+\.?\d*%/, `$1${current.functions.toFixed(2)}%`)
    .replace(/(\|\s*Lines\s*\|\s*)\d+\.?\d*%/, `$1${current.lines.toFixed(2)}%`)
    // Match the whole rest of the line — the file carries ISO dates, and the
    // previous "July 4, 2026"-style pattern silently skipped them, leaving
    // stale dates behind refreshed percentages.
    .replace(/\*\*Last Updated:\*\*.*$/m, `**Last Updated:** ${today}`);

  return `${before}${refreshed}${after}`;
};
