#!/usr/bin/env tsx
/**
 * Template Initialisation Script
 *
 * Run once, immediately after generating a repository from this template:
 *
 *     pnpm run init-template
 *
 * It rewrites the files that carry the template's identity — package.json,
 * README.md, LICENSE and COVERAGE_METRICS.md — with the new project's name,
 * description and author; removes `docs/lessons/` along with every deep link
 * into it; then deletes itself and its spec, so a generated project carries no
 * trace of the bootstrap.
 *
 * The project name is resolved in order: `--name`, the `origin` git remote,
 * the containing directory's name.
 *
 * Usage:
 *   pnpm run init-template
 *   pnpm run init-template -- --name my-app --description "Does a thing."
 *   pnpm run init-template -- --author "Ada Lovelace <ada@example.com>"
 *   pnpm run init-template -- --dry-run
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type CoverageMetrics, parseThresholdsFromConfig, refreshMetricsContent } from './check-coverage-regression';

/** Identity of the project being generated, after all fallbacks are applied. */
export interface ProjectMeta {
  /** npm-safe package name, also the README H1. */
  name: string;
  /** One-line description for package.json and the README lead paragraph. */
  description: string;
  /** Copyright holder for LICENSE and the README licence line. */
  author: string;
  /** Four-digit copyright year. */
  year: string;
}

/** The subset of {@link ProjectMeta} a caller may pass explicitly on the CLI. */
export interface ExplicitMeta {
  name?: string;
  description?: string;
  author?: string;
}

/** Everything {@link buildProjectMeta} needs, with all IO already performed. */
export interface MetaSources {
  explicit: ExplicitMeta;
  /** `origin`'s URL, or null when the repo has no remote yet. */
  remoteUrl: string | null;
  /** Basename of the project root, used as the last-resort name. */
  directoryName: string;
  year: string;
}

/** Result of {@link validateProjectName} — a discriminated union, not a boolean. */
export type NameValidation = { valid: true } | { valid: false; reason: string };

/** Keywords that describe the template itself rather than any generated project. */
const TEMPLATE_ONLY_KEYWORDS = new Set(['starter', 'template']);

/** npm's own hard cap on package-name length. */
const MAX_NAME_LENGTH = 214;

/** The package.json script entry that invokes this file; removed on self-delete. */
const INIT_SCRIPT_KEY = 'init-template';

/**
 * Extract the repository name from a git remote URL.
 *
 * Handles the three shapes git hands back — scp-style (`git@host:org/repo.git`),
 * `https://host/org/repo.git`, and `ssh://git@host/org/repo.git` — with or
 * without the `.git` suffix or a trailing slash.
 *
 * @param url A remote URL, e.g. from `git remote get-url origin`.
 * @returns The bare repository name, or null when the URL yields no usable name.
 */
export const parseRepoName = (url: string): string | null => {
  const trimmed = url.trim();

  // Require a host separator so a bare word is not mistaken for a remote URL.
  if (!trimmed.includes('/') && !trimmed.includes(':')) {
    return null;
  }

  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  const lastSegment = withoutTrailingSlash.split(/[/:]/).pop() ?? '';
  const name = lastSegment.replace(/\.git$/, '');

  return name.length > 0 ? name : null;
};

/**
 * Check a project name against npm's package-name rules.
 *
 * @param name The candidate name.
 * @returns `{ valid: true }`, or `{ valid: false, reason }` explaining the failure.
 */
export const validateProjectName = (name: string): NameValidation => {
  if (name.length === 0) {
    return { valid: false, reason: 'Project name is empty.' };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return { valid: false, reason: `Project name exceeds npm's ${MAX_NAME_LENGTH}-character limit.` };
  }

  if (name.startsWith('.') || name.startsWith('_')) {
    return { valid: false, reason: 'Project name cannot start with a dot or an underscore.' };
  }

  if (name !== name.toLowerCase()) {
    return { valid: false, reason: 'Project name must be lowercase.' };
  }

  if (!/^[a-z0-9\-._~]+$/.test(name)) {
    return {
      valid: false,
      reason: 'Project name may only contain lowercase letters, digits, and the characters - . _ ~',
    };
  }

  return { valid: true };
};

/**
 * Resolve the final project identity from explicit flags and discovered defaults.
 *
 * Pure — every source is passed in, so the precedence rules are testable
 * without a git repository or a filesystem.
 *
 * @param sources Explicit CLI values plus the discovered remote, directory and year.
 * @returns The fully resolved metadata.
 */
export const buildProjectMeta = (sources: MetaSources): ProjectMeta => {
  const { explicit, remoteUrl, directoryName, year } = sources;
  const fromRemote = remoteUrl === null ? null : parseRepoName(remoteUrl);
  const name = explicit.name ?? fromRemote ?? directoryName;

  return {
    name,
    description: explicit.description ?? `${name} — a Next.js application.`,
    author: explicit.author ?? '',
    year,
  };
};

/**
 * Rewrite package.json for the new project.
 *
 * Resets the version to `0.1.0` (the template's own version is meaningless to a
 * generated project), strips the template-only keywords, and removes the
 * `init-template` script this file is invoked by. Key order is preserved
 * because `JSON.parse`/`JSON.stringify` round-trip insertion order.
 *
 * Idempotent: running it twice produces the same output.
 *
 * @param content Raw package.json text.
 * @param meta Resolved project metadata.
 * @returns The rewritten JSON, newline-terminated.
 */
export const rewritePackageJson = (content: string, meta: ProjectMeta): string => {
  const pkg = JSON.parse(content);

  pkg.name = meta.name;
  pkg.version = '0.1.0';
  pkg.description = meta.description;

  if (meta.author.length > 0) {
    pkg.author = meta.author;
  }

  if (Array.isArray(pkg.keywords)) {
    pkg.keywords = pkg.keywords.filter((keyword: unknown) => !TEMPLATE_ONLY_KEYWORDS.has(String(keyword)));
  }

  // Rebuild rather than `delete pkg.scripts[key]` — a computed-key write trips
  // security/detect-object-injection, and Object.entries preserves order anyway.
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    pkg.scripts = Object.fromEntries(
      Object.entries(pkg.scripts).filter(([scriptName]) => scriptName !== INIT_SCRIPT_KEY)
    );
  }

  return `${JSON.stringify(pkg, null, 2)}\n`;
};

/** Heading of the README section that documents this script, removed along with it. */
const INIT_SECTION_HEADING = /^##\s+Initialising a generated project\s*$/;

/**
 * Drop a whole H2 section — its heading and every line up to the next H2.
 *
 * @param lines The document, split on newlines.
 * @param heading Pattern matching the section's heading line.
 * @returns The remaining lines.
 */
const dropSection = (lines: readonly string[], heading: RegExp): string[] => {
  const output: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (heading.test(line)) {
      skipping = true;
      continue;
    }

    if (skipping) {
      if (!/^##\s+/.test(line)) {
        continue;
      }
      skipping = false;
    }

    output.push(line);
  }

  return output;
};

/**
 * Replace the H1 and the prose paragraph that follows it.
 *
 * The lead is Prettier-wrapped across several lines, so the whole paragraph is
 * swallowed up to the next blank line — replacing only its first line would
 * leave the remainder orphaned under the new description.
 *
 * @param lines The document, split on newlines.
 * @param meta Resolved project metadata.
 * @returns The rewritten lines.
 */
const replaceTitleAndLead = (lines: readonly string[], meta: ProjectMeta): string[] => {
  const output: string[] = [];
  let replacedLead = false;
  let skippingLead = false;

  for (const line of lines) {
    if (skippingLead) {
      if (line.trim().length === 0) {
        skippingLead = false;
        output.push(line);
      }
      continue;
    }

    if (output.length === 0 && /^#\s+\S/.test(line)) {
      output.push(`# ${meta.name}`);
      continue;
    }

    if (!replacedLead && output.length > 0 && line.trim().length > 0 && !line.startsWith('#')) {
      output.push(meta.description);
      replacedLead = true;
      skippingLead = true;
      continue;
    }

    output.push(line);
  }

  return output;
};

/**
 * Rewrite README.md for the new project.
 *
 * Replaces the H1 and the lead paragraph, drops the section documenting this
 * script, and re-attributes the licence line. Everything else — the stack
 * table, the lessons, the oxlint rationale — is deliberately kept.
 *
 * @param content Raw README.md text.
 * @param meta Resolved project metadata.
 * @returns The rewritten Markdown.
 */
export const rewriteReadme = (content: string, meta: ProjectMeta): string => {
  const withoutInitSection = dropSection(content.split('\n'), INIT_SECTION_HEADING);
  const retitled = replaceTitleAndLead(withoutInitSection, meta);
  const attribution = meta.author.length > 0 ? meta.author : 'the project authors';

  return (
    retitled
      .map((line) => (line.startsWith('MIT © ') ? `MIT © ${attribution}` : line))
      .join('\n')
      // Dropping lines can leave a run of blank lines behind; collapse any run
      // of three or more down to the single blank line Prettier would keep.
      .replace(/\n{3,}/g, '\n\n')
  );
};

/**
 * Rewrite the LICENSE copyright line for the new project.
 *
 * @param content Raw LICENSE text.
 * @param meta Resolved project metadata.
 * @returns The rewritten licence.
 */
export const rewriteLicense = (content: string, meta: ProjectMeta): string => {
  if (meta.author.length === 0) {
    return content.replace(/^(Copyright \(c\) )\d{4}/m, `$1${meta.year}`);
  }

  return content.replace(/^Copyright \(c\) \d{4}.*$/m, `Copyright (c) ${meta.year} ${meta.author}`);
};

/**
 * Reset COVERAGE_METRICS.md so a generated project starts from its own baseline.
 *
 * The summary table is seeded from `vitest.config.ts`'s thresholds rather than
 * the template's own 100%, so the regression gate is meaningful from the first
 * run without failing the moment any uncovered line is added. The template's
 * Coverage History describes the template's past, not this project's, so it is
 * replaced by a single seed row.
 *
 * @param content Raw COVERAGE_METRICS.md text.
 * @param meta Resolved project metadata.
 * @param thresholds Coverage thresholds parsed from vitest.config.ts.
 * @param today ISO date (YYYY-MM-DD) to stamp.
 * @returns The rewritten Markdown.
 */
export const rewriteCoverageMetrics = (
  content: string,
  meta: ProjectMeta,
  thresholds: CoverageMetrics,
  today: string
): string => {
  const withBaseline = refreshMetricsContent(content, thresholds, today).replace(
    /^Tracks test coverage for this template\.$/m,
    `Tracks test coverage for **${meta.name}**.`
  );

  const seedRow =
    `| ${today} | ${thresholds.statements.toFixed(2)}%${' '.repeat(4)} | ` +
    `${thresholds.branches.toFixed(2)}%${' '.repeat(2)} | ` +
    `${thresholds.functions.toFixed(2)}%${' '.repeat(3)} | ` +
    `${thresholds.lines.toFixed(2)}% | Initialised from template thresholds |`;

  const lines = withBaseline.split('\n');
  const output: string[] = [];
  let seeded = false;

  for (const line of lines) {
    // History rows are the only ones that open with an ISO date.
    if (/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) {
      if (!seeded) {
        output.push(seedRow);
        seeded = true;
      }
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
};

/**
 * A deep link to one lesson file, e.g. ``docs/lessons/tooling/some-lesson.md``.
 *
 * Requires a `.md` filename, which is exactly what separates a dangling deep
 * link from a structural mention of the convention — `docs/lessons/`,
 * `docs/lessons/<category>/`, a tree listing. Those name no file and stay
 * valid in a generated project, which still writes lessons of its own.
 */
const LESSON_FILE_LINK = /docs\/lessons\/[^\s)`]+\.md/;

/**
 * Remove references to individual lesson files.
 *
 * `init-template` deletes `docs/lessons/`, since the lessons record this
 * template's history rather than the new project's. Every deep link to one is
 * dropped with them; each already states its reason inline, so what is lost is
 * the long-form background, not the warning itself.
 *
 * Each such link occupies a whole line in this template — deliberately, so
 * removal is line-exact rather than prose surgery. Keep it that way.
 *
 * @param content Raw text of a file that may reference a lesson.
 * @returns The text with lesson-file reference lines removed.
 */
export const stripLessonLinks = (content: string): string =>
  content
    .split('\n')
    .filter((line) => !LESSON_FILE_LINK.test(line))
    .join('\n')
    // A removed standalone paragraph leaves a doubled blank line behind.
    .replace(/\n{3,}/g, '\n\n');

/** Extensions Prettier can infer a parser for, among the files this script rewrites. */
const PRETTIER_EXTENSIONS = new Set(['.json', '.md']);

/**
 * Whether Prettier can format a file, judged by extension.
 *
 * `LICENSE` has none, and Prettier exits non-zero with "No parser could be
 * inferred" when handed it — failing the whole `--write` invocation and leaving
 * the other files unformatted with only a warning to show for it.
 *
 * @param relativePath Path of a rewritten file, relative to the project root.
 * @returns True when the file can be passed to `prettier --write`.
 */
export const isPrettierFormattable = (relativePath: string): boolean =>
  PRETTIER_EXTENSIONS.has(path.extname(relativePath));

/**
 * Parse `--flag value` pairs and bare `--flag` switches from argv.
 *
 * @param argv Arguments after the node executable and script path.
 * @returns A map of flag name (without `--`) to value; switches map to `''`.
 */
export const parseArgs = (argv: readonly string[]): Map<string, string> => {
  const flags = new Map<string, string>();
  // Iterate rather than index — a computed `argv[index]` read trips
  // security/detect-object-injection, and a pending key carries the same state.
  let pendingKey: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      if (pendingKey !== null) {
        flags.set(pendingKey, '');
      }
      pendingKey = arg.slice(2);
      continue;
    }

    if (pendingKey !== null) {
      flags.set(pendingKey, arg);
      pendingKey = null;
    }
  }

  if (pendingKey !== null) {
    flags.set(pendingKey, '');
  }

  return flags;
};

/** Read `origin`'s URL, or null when there is no repo or no such remote. */
const readRemoteUrl = (): string | null => {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

/** Files this script removes from the generated project once it has run. */
const SELF_FILES = ['scripts/init-from-template.ts', 'scripts/init-from-template.spec.ts'];

/**
 * The lessons directory, removed wholesale.
 *
 * Its files record incidents from this template's own history — a fresh
 * project inherits them as stale docs, not as a head start. The convention
 * survives in AGENTS.md, so the new project writes its own.
 */
const LESSONS_DIR = 'docs/lessons';

/**
 * Delete the lessons directory, and `docs/` too if nothing else lived there.
 *
 * @param root Absolute path to the project root.
 * @param dryRun When true, nothing is deleted.
 */
const removeLessons = (root: string, dryRun: boolean): void => {
  const lessonsPath = path.join(root, LESSONS_DIR);

  if (!fs.existsSync(lessonsPath)) {
    return;
  }

  if (!dryRun) {
    fs.rmSync(lessonsPath, { recursive: true });

    const docsPath = path.dirname(lessonsPath);
    if (fs.readdirSync(docsPath).length === 0) {
      fs.rmSync(docsPath, { recursive: true });
    }
  }

  console.info(`${dryRun ? '👀' : '🗑️ '} ${LESSONS_DIR}/ (removed)`);
};

/** The template's own name — refusing it is what stops a no-op initialisation. */
const TEMPLATE_NAME = 'next-kitchen-sink';

/** One file to rewrite, paired with the pure transform that rewrites it. */
type Rewrite = [relativePath: string, transform: (content: string) => string];

/**
 * Resolve project metadata from argv and the environment, exiting on a bad name.
 *
 * @param flags Parsed CLI flags.
 * @param root Absolute path to the project root.
 * @returns Validated metadata.
 */
const resolveMeta = (flags: Map<string, string>, root: string): ProjectMeta => {
  const meta = buildProjectMeta({
    explicit: {
      name: flags.get('name') || undefined,
      description: flags.get('description') || undefined,
      author: flags.get('author') || undefined,
    },
    remoteUrl: readRemoteUrl(),
    directoryName: path.basename(root),
    year: new Date().getFullYear().toString(),
  });

  const validation = validateProjectName(meta.name);
  if (!validation.valid) {
    console.error(`❌ ${validation.reason}`);
    console.error(`   Resolved name was "${meta.name}". Pass a valid one with --name.`);
    process.exit(1);
  }

  if (meta.name === TEMPLATE_NAME) {
    console.error(`❌ The project name is still "${TEMPLATE_NAME}".`);
    console.error('   Rename the repository or pass --name <your-project>.');
    process.exit(1);
  }

  return meta;
};

/**
 * Apply each rewrite in turn, reporting what was touched.
 *
 * @param root Absolute path to the project root.
 * @param rewrites The files and their transforms.
 * @param dryRun When true, nothing is written.
 */
const applyRewrites = (root: string, rewrites: readonly Rewrite[], dryRun: boolean): void => {
  for (const [relativePath, transform] of rewrites) {
    const absolutePath = path.join(root, relativePath);

    if (!fs.existsSync(absolutePath)) {
      console.warn(`⚠️  ${relativePath} not found — skipped.`);
      continue;
    }

    const rewritten = transform(fs.readFileSync(absolutePath, 'utf-8'));

    if (!dryRun) {
      fs.writeFileSync(absolutePath, rewritten);
    }

    console.info(`${dryRun ? '👀' : '✏️ '} ${relativePath}`);
  }
};

/**
 * Delete this script and its spec, so the generated project carries no bootstrap.
 *
 * @param root Absolute path to the project root.
 * @param dryRun When true, nothing is deleted.
 */
const removeSelf = (root: string, dryRun: boolean): void => {
  for (const relativePath of SELF_FILES) {
    const absolutePath = path.join(root, relativePath);

    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    if (!dryRun) {
      fs.rmSync(absolutePath);
    }

    console.info(`${dryRun ? '👀' : '🗑️ '} ${relativePath} (removed)`);
  }
};

/**
 * Hand the rewritten files to Prettier, which owns their final formatting.
 *
 * `JSON.stringify` and the Markdown edits above are not guaranteed to match
 * Prettier's output (array collapsing, in particular). The local bin is invoked
 * directly rather than through `pnpm exec`, which runs a deps-status precheck
 * that can fail for reasons unrelated to formatting.
 *
 * @param root Absolute path to the project root.
 * @param rewrites The files that were rewritten.
 */
const formatRewritten = (root: string, rewrites: readonly Rewrite[]): void => {
  const prettierBin = path.join(root, 'node_modules', '.bin', 'prettier');
  const formattable = rewrites.map(([file]) => file).filter(isPrettierFormattable);

  try {
    execFileSync(prettierBin, ['--write', ...formattable], { stdio: 'ignore' });
    console.info('\n🎨 Formatted the rewritten files with Prettier.');
  } catch {
    console.warn('\n⚠️  Could not run Prettier — run `pnpm run format` yourself.');
  }
};

/**
 * Main execution — the only impure part of this module.
 */
const main = (): void => {
  const root = process.cwd();
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = flags.has('dry-run');

  console.info('🌱 Initialising this project from the template...\n');

  const meta = resolveMeta(flags, root);
  const today = new Date().toISOString().split('T')[0];
  const thresholds = parseThresholdsFromConfig(fs.readFileSync(path.join(root, 'vitest.config.ts'), 'utf-8'));

  const rewrites: Rewrite[] = [
    ['package.json', (content) => rewritePackageJson(content, meta)],
    ['README.md', (content) => stripLessonLinks(rewriteReadme(content, meta))],
    ['LICENSE', (content) => rewriteLicense(content, meta)],
    ['COVERAGE_METRICS.md', (content) => rewriteCoverageMetrics(content, meta, thresholds, today)],
    // The other two files carrying a deep link into the lessons directory.
    ['AGENTS.md', stripLessonLinks],
    ['lint-staged.config.mjs', stripLessonLinks],
  ];

  console.info(`   name:        ${meta.name}`);
  console.info(`   description: ${meta.description}`);
  console.info(`   author:      ${meta.author.length > 0 ? meta.author : '(unchanged)'}`);
  console.info(
    `   baseline:    ${thresholds.statements}/${thresholds.branches}/${thresholds.functions}/${thresholds.lines}\n`
  );

  applyRewrites(root, rewrites, dryRun);
  removeLessons(root, dryRun);
  removeSelf(root, dryRun);

  if (dryRun) {
    console.info('\n👀 Dry run — nothing was written.\n');
    return;
  }

  formatRewritten(root, rewrites);

  console.info('\n✅ Done. Next steps:\n');
  console.info('   git add -A && git commit -m "chore: 🔧 initialise from template"\n');
};

// True when this file is executed directly, not imported (ESM-safe require.main === module)
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
