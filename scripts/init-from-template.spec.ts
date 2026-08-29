import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isHistoryRow } from './coverage-gate';
import {
  buildProjectMeta,
  buildRewrites,
  createFileOps,
  isPrettierFormattable,
  parseArgs,
  parseRepoName,
  rewriteCoverageMetrics,
  rewriteLicense,
  rewritePackageJson,
  rewriteReadme,
  stripLessonLinks,
  validateProjectName,
} from './init-from-template';

const META = {
  name: 'my-app',
  description: 'A very specific application.',
  author: 'Ada Lovelace <ada@example.com>',
  year: '2027',
};

describe('parseRepoName', () => {
  it.each([
    ['scp-style ssh', 'git@github.com:braveneworg/my-app.git', 'my-app'],
    ['scp-style ssh without .git', 'git@github.com:braveneworg/my-app', 'my-app'],
    ['https with .git', 'https://github.com/braveneworg/my-app.git', 'my-app'],
    ['https without .git', 'https://github.com/braveneworg/my-app', 'my-app'],
    ['ssh:// url', 'ssh://git@github.com/braveneworg/my-app.git', 'my-app'],
    ['a trailing slash', 'https://github.com/braveneworg/my-app/', 'my-app'],
    ['a nested group path', 'https://gitlab.com/group/subgroup/my-app.git', 'my-app'],
  ])('extracts the repo name from %s', (_label, url, expected) => {
    expect(parseRepoName(url)).toBe(expected);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a bare word with no host separator', 'my-app'],
  ])('returns null for %s', (_label, url) => {
    expect(parseRepoName(url)).toBeNull();
  });

  // A repo whose name is only ".git" leaves nothing behind once the suffix is
  // stripped; that must read as "no name", not as an empty-string name.
  it('returns null when stripping .git leaves nothing', () => {
    expect(parseRepoName('git@github.com:braveneworg/.git')).toBeNull();
  });
});

describe('validateProjectName', () => {
  it.each([['my-app'], ['my_app'], ['app2'], ['a'], ['scoped.name']])('accepts %s', (name) => {
    expect(validateProjectName(name)).toEqual({ valid: true });
  });

  it.each([
    ['an empty name', '', /empty/i],
    ['uppercase letters', 'MyApp', /lowercase/i],
    ['spaces', 'my app', /lowercase|characters/i],
    ['a leading dot', '.my-app', /start/i],
    ['a leading underscore', '_my-app', /start/i],
    ['over 214 characters', 'a'.repeat(215), /214/],
  ])('rejects %s', (_label, name, reason) => {
    const result = validateProjectName(name);

    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(reason);
  });
});

describe('buildProjectMeta', () => {
  it('prefers an explicit name over the git remote', () => {
    const meta = buildProjectMeta({
      explicit: { name: 'chosen' },
      remoteUrl: 'git@github.com:braveneworg/from-remote.git',
      directoryName: 'from-dir',
      year: '2027',
    });

    expect(meta.name).toBe('chosen');
  });

  it('falls back to the git remote when no name is given', () => {
    const meta = buildProjectMeta({
      explicit: {},
      remoteUrl: 'git@github.com:braveneworg/from-remote.git',
      directoryName: 'from-dir',
      year: '2027',
    });

    expect(meta.name).toBe('from-remote');
  });

  it('falls back to the directory name when the remote is absent or unparseable', () => {
    const meta = buildProjectMeta({ explicit: {}, remoteUrl: null, directoryName: 'from-dir', year: '2027' });

    expect(meta.name).toBe('from-dir');
  });

  it('derives a default description from the resolved name', () => {
    const meta = buildProjectMeta({ explicit: {}, remoteUrl: null, directoryName: 'from-dir', year: '2027' });

    expect(meta.description).toContain('from-dir');
  });

  it('keeps an explicit description and author', () => {
    const meta = buildProjectMeta({
      explicit: { description: 'Explicit.', author: 'Ada' },
      remoteUrl: null,
      directoryName: 'from-dir',
      year: '2027',
    });

    expect(meta.description).toBe('Explicit.');
    expect(meta.author).toBe('Ada');
  });
});

describe('rewritePackageJson', () => {
  const source = JSON.stringify(
    {
      name: 'next-kitchen-sink',
      version: '1.0.0',
      description: 'A starter template for Next.js applications.',
      keywords: ['starter', 'template', 'nextjs'],
      author: 'Michaux Kelley <me@mkelley33.com>',
      scripts: { dev: 'next dev --turbopack', 'init-template': 'tsx scripts/init-from-template.ts' },
    },
    null,
    2
  );

  it('replaces name, description and author', () => {
    const parsed = JSON.parse(rewritePackageJson(source, META));

    expect(parsed.name).toBe('my-app');
    expect(parsed.description).toBe('A very specific application.');
    expect(parsed.author).toBe('Ada Lovelace <ada@example.com>');
  });

  it('resets the version to 0.1.0 so the new project starts its own history', () => {
    expect(JSON.parse(rewritePackageJson(source, META)).version).toBe('0.1.0');
  });

  it('drops the template-only keywords but keeps stack keywords', () => {
    const { keywords } = JSON.parse(rewritePackageJson(source, META));

    expect(keywords).not.toContain('starter');
    expect(keywords).not.toContain('template');
    expect(keywords).toContain('nextjs');
  });

  it('removes its own init-template script entry', () => {
    const { scripts } = JSON.parse(rewritePackageJson(source, META));

    expect(scripts['init-template']).toBeUndefined();
    expect(scripts.dev).toBe('next dev --turbopack');
  });

  it('preserves key order and ends with a newline', () => {
    const result = rewritePackageJson(source, META);

    expect(Object.keys(JSON.parse(result)).slice(0, 4)).toEqual(['name', 'version', 'description', 'keywords']);
    expect(result.endsWith('\n')).toBe(true);
  });

  it('leaves an already-initialised package.json idempotent', () => {
    const once = rewritePackageJson(source, META);

    expect(rewritePackageJson(once, META)).toBe(once);
  });

  it('keeps the template author when none is supplied', () => {
    const { author } = JSON.parse(rewritePackageJson(source, { ...META, author: '' }));

    expect(author).toBe('Michaux Kelley <me@mkelley33.com>');
  });
});

describe('stripLessonLinks against the real documents', () => {
  // The whole LINE carrying a lesson link is removed, so a link has to be a
  // self-contained sentence. Appending one to the end of a prose sentence —
  // "…give helpers named tokens — see \n  `docs/lessons/…md`." — leaves the
  // front half dangling in every generated project. These are the two files
  // `main()` runs stripLessonLinks over.
  it.each(['AGENTS.md', 'README.md', 'lint-staged.config.mjs'])('leaves no dangling connector in %s', (file) => {
    const lines = readFileSync(join(import.meta.dirname, '..', file), 'utf-8').split('\n');

    // Checked against the line BEFORE each link rather than the stripped
    // output: ordinary wrapped prose ends with an em-dash all the time, and
    // only a continuation into a line that is about to be deleted matters.
    const orphaned = lines.filter(
      (line, index) =>
        /docs\/lessons\/[^\s)`]+\.md/.test(line) && /(?:[—–-]|\bsee|\bin|\bat)\s*$/i.test(lines.at(index - 1) ?? '')
    );

    expect(orphaned).toEqual([]);
  });
});

describe('stripLessonLinks', () => {
  it('removes a Markdown bullet reference, keeping the reason stated above it', () => {
    const source = [
      '- oxlint 1 (`.oxlintrc.json`), not ESLint — typescript-eslint hard-throws on',
      '  TypeScript 7, so the whole ESLint stack is incompatible.',
      '  See `docs/lessons/tooling/typescript-7-has-no-js-compiler-api.md`.',
      '  `eslint-plugin-security` still runs.',
    ].join('\n');

    const result = stripLessonLinks(source);

    expect(result).not.toContain('docs/lessons/tooling/typescript-7');
    expect(result).toContain('the whole ESLint stack is incompatible.');
    expect(result).toContain('`eslint-plugin-security` still runs.');
  });

  it('removes a linked Markdown reference', () => {
    const source = [
      'Some prose.',
      '',
      'See [`docs/lessons/tooling/tsc-files-silently-passes-under-pnpm.md`](docs/lessons/tooling/tsc-files-silently-passes-under-pnpm.md) for the full background.',
      '',
      '## License',
    ].join('\n');

    const result = stripLessonLinks(source);

    expect(result).not.toContain('docs/lessons');
    expect(result).toContain('Some prose.');
    expect(result).toContain('## License');
  });

  it('removes a reference from a JS block comment', () => {
    const source = [
      ' * everything.',
      ' * See docs/lessons/tooling/tsc-files-silently-passes-under-pnpm.md.',
      ' *',
      " * @type {import('lint-staged').Configuration}",
    ].join('\n');

    const result = stripLessonLinks(source);

    expect(result).not.toContain('docs/lessons');
    expect(result).toContain(' * everything.');
    expect(result).toContain('@type');
  });

  // Structural mentions of the convention must survive — a generated project
  // still writes its own lessons, so AGENTS.md's category table stays valid.
  // Only deep links to a specific `.md` file dangle once the files are gone.
  it.each([
    ['the directory convention', 'hard-won lessons in `docs/lessons/` — load on demand'],
    ['a category path', 'lessons live in `docs/lessons/<category>/` — one file per lesson'],
    ['a category directory', 'Load `docs/lessons/react-nextjs/` before UI work.'],
    ['a tree listing', 'docs/lessons/               # Repo-specific lessons, grouped by category'],
  ])('keeps %s', (_label, line) => {
    expect(stripLessonLinks(line)).toBe(line);
  });

  it('collapses the blank-line run a removed paragraph leaves behind', () => {
    const source = ['Prose.', '', 'See `docs/lessons/tooling/foo.md` for background.', '', 'More prose.'].join('\n');

    expect(stripLessonLinks(source)).not.toMatch(/\n{3,}/);
  });

  it('is a no-op on content with no lesson links', () => {
    const source = '# Title\n\nNothing to see here.\n';

    expect(stripLessonLinks(source)).toBe(source);
  });
});

describe('isPrettierFormattable', () => {
  it.each([['package.json'], ['README.md'], ['COVERAGE_METRICS.md']])('accepts %s', (file) => {
    expect(isPrettierFormattable(file)).toBe(true);
  });

  // Prettier exits non-zero with "No parser could be inferred" on an
  // extensionless file, which would fail the whole --write invocation and
  // silently leave the other three files unformatted.
  it('rejects the extensionless LICENSE', () => {
    expect(isPrettierFormattable('LICENSE')).toBe(false);
  });
});

describe('parseArgs', () => {
  it('reads --flag value pairs', () => {
    const flags = parseArgs(['--name', 'my-app', '--description', 'Does a thing.']);

    expect(flags.get('name')).toBe('my-app');
    expect(flags.get('description')).toBe('Does a thing.');
  });

  it('treats a flag with no value as a switch', () => {
    const flags = parseArgs(['--dry-run']);

    expect(flags.has('dry-run')).toBe(true);
    expect(flags.get('dry-run')).toBe('');
  });

  // `--name --dry-run` must not swallow the next flag as the name's value.
  it('does not consume a following flag as a value', () => {
    const flags = parseArgs(['--name', '--dry-run']);

    expect(flags.get('name')).toBe('');
    expect(flags.has('dry-run')).toBe(true);
  });

  it('ignores positional arguments', () => {
    expect(parseArgs(['positional', '--name', 'my-app']).get('name')).toBe('my-app');
  });
});

describe('rewriteReadme', () => {
  const source = [
    '# next-kitchen-sink',
    '',
    'A starter template for Next.js applications — App Router, React 19.',
    '',
    '## Tech stack',
    '',
    'Some content that mentions next-kitchen-sink in passing.',
    '',
    '## Initialising a generated project',
    '',
    'Run `pnpm run init-template` once, right after generating.',
    '',
    '## License',
    '',
    'MIT © Michaux Kelley',
    '',
  ].join('\n');

  it('replaces the H1 title with the project name', () => {
    const result = rewriteReadme(source, META);

    expect(result.startsWith('# my-app\n')).toBe(true);
    expect(result).not.toContain('# next-kitchen-sink');
  });

  it('replaces the lead paragraph with the project description', () => {
    expect(rewriteReadme(source, META)).toContain('A very specific application.');
  });

  // The real README's lead is a Prettier-wrapped paragraph, not one line.
  // Replacing only its first line would leave the remaining lines orphaned
  // under the new description.
  it('replaces every line of a wrapped lead paragraph', () => {
    const wrapped = [
      '# next-kitchen-sink',
      '',
      'A starter template for Next.js applications — App Router, React 19, TypeScript 7, Tailwind v4, shadcn/ui,',
      'and TanStack Query, wired up with a full test and quality-gate toolchain so a new project starts at',
      'production standards instead of growing into them.',
      '',
      '## Tech stack',
      '',
    ].join('\n');

    const result = rewriteReadme(wrapped, META);

    expect(result).toContain('A very specific application.');
    expect(result).not.toContain('and TanStack Query, wired up');
    expect(result).not.toContain('production standards instead of growing into them.');
    expect(result).toContain('## Tech stack');
  });

  it('updates the license attribution to the author', () => {
    const result = rewriteReadme(source, META);

    expect(result).toContain('MIT © Ada Lovelace <ada@example.com>');
    expect(result).not.toContain('MIT © Michaux Kelley');
  });

  // The section documents a script that deletes itself, so it must go too —
  // otherwise every generated README tells the reader to run a missing command.
  it('removes the "Initialising a generated project" section', () => {
    const result = rewriteReadme(source, META);

    expect(result).not.toContain('Initialising a generated project');
    expect(result).not.toContain('pnpm run init-template');
    expect(result).toContain('## Tech stack');
    expect(result).toContain('## License');
  });

  it('leaves the rest of the document untouched', () => {
    expect(rewriteReadme(source, META)).toContain('Some content that mentions next-kitchen-sink in passing.');
  });

  it('falls back to a generic attribution when no author is supplied', () => {
    expect(rewriteReadme(source, { ...META, author: '' })).toContain('MIT © the project authors');
  });

  it('collapses the blank-line runs left behind by removed lines', () => {
    expect(rewriteReadme(source, META)).not.toMatch(/\n{3,}/);
  });
});

describe('rewriteLicense', () => {
  const source = ['MIT License', '', 'Copyright (c) 2026 Michaux Kelley', '', 'Permission is hereby granted,'].join(
    '\n'
  );

  it('rewrites the copyright year and holder', () => {
    const result = rewriteLicense(source, META);

    expect(result).toContain('Copyright (c) 2027 Ada Lovelace <ada@example.com>');
    expect(result).not.toContain('2026 Michaux Kelley');
  });

  it('leaves the licence body untouched', () => {
    expect(rewriteLicense(source, META)).toContain('Permission is hereby granted,');
  });

  // No --author means the template owner stays the copyright holder; only the
  // year moves, so a January-generated project is not stamped with last year.
  it('updates only the year when no author is supplied', () => {
    const result = rewriteLicense(source, { ...META, author: '' });

    expect(result).toContain('Copyright (c) 2027 Michaux Kelley');
  });
});

describe('rewriteCoverageMetrics', () => {
  const thresholds = { statements: 95, branches: 85, functions: 95, lines: 95 };
  const source = [
    '# Coverage Metrics',
    '',
    'Tracks test coverage for this template.',
    '',
    '## Current Coverage Summary',
    '',
    '| Metric     | Coverage |',
    '| ---------- | -------- |',
    '| Statements | 100.00%  |',
    '| Branches   | 100.00%  |',
    '| Functions  | 100.00%  |',
    '| Lines      | 100.00%  |',
    '',
    '**Last Updated:** 2026-08-16',
    '',
    '## Coverage History',
    '',
    '| Date       | Statements | Branches | Functions | Lines   | Notes    |',
    '| ---------- | ---------- | -------- | --------- | ------- | -------- |',
    '| 2026-08-16 | 100.00%    | 100.00%  | 100.00%   | 100.00% | Later    |',
    '| 2026-08-15 | 100.00%    | 100.00%  | 100.00%   | 100.00% | Earlier  |',
    '',
  ].join('\n');

  const result = (): string => rewriteCoverageMetrics(source, META, thresholds, '2027-01-09');

  it('seeds the baseline from the vitest thresholds', () => {
    expect(result()).toMatch(/\| Statements \| 95\.00%/);
    expect(result()).toMatch(/\| Branches\s+\| 85\.00%/);
    expect(result()).toMatch(/\| Functions\s+\| 95\.00%/);
    expect(result()).toMatch(/\| Lines\s+\| 95\.00%/);
  });

  it('stamps the initialisation date', () => {
    expect(result()).toContain('**Last Updated:** 2027-01-09');
  });

  it('names the project instead of "this template"', () => {
    expect(result()).toContain('Tracks test coverage for **my-app**.');
    expect(result()).not.toContain('for this template.');
  });

  // The template's history rows describe the template's own past, which is not
  // this project's past. One seeded row keeps the table's shape valid.
  //
  // Filtered with the implementation's own `isHistoryRow`, not a copy of the
  // rule: this spec used to re-derive it with literal single spaces where the
  // implementation allowed `\s*`, so the two disagreed about what counted as a
  // history row and the test could pass on output the code would mishandle.
  it('replaces the coverage history with a single seed row', () => {
    const historyRows = result().split('\n').filter(isHistoryRow);

    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]).toContain('2027-01-09');
    expect(historyRows[0]).toMatch(/95\.00%/);
    expect(historyRows[0]).toMatch(/Initialised from template/i);
  });
});

describe('buildRewrites', () => {
  const THRESHOLDS = { statements: 95, branches: 85, functions: 90, lines: 92 };

  // The manifest used to be a literal inside `main`, so "which files does this
  // script touch?" was only answerable by running it. It is data now.
  it('names every file it will rewrite, in order', () => {
    expect(buildRewrites(META, THRESHOLDS, '2027-01-09').map(([file]) => file)).toEqual([
      'package.json',
      'README.md',
      'LICENSE',
      'COVERAGE_METRICS.md',
      'AGENTS.md',
      'lint-staged.config.mjs',
    ]);
  });

  // Each transform's own behaviour is covered above; what matters here is that
  // the manifest pairs every file with one, and that reading the manifest
  // touches no disk.
  it('pairs every file with a transform', () => {
    const transforms = buildRewrites(META, THRESHOLDS, '2027-01-09').map(([, transform]) => typeof transform);

    expect(transforms).toEqual(['function', 'function', 'function', 'function', 'function', 'function']);
  });

  it('threads the thresholds into the coverage transform', () => {
    const entry = buildRewrites(META, THRESHOLDS, '2027-01-09').find(([file]) => file === 'COVERAGE_METRICS.md');
    const source = ['## Current Coverage Summary', '', '| Statements | 12.00% |', '', '## Coverage History', ''].join(
      '\n'
    );

    expect(entry?.[1](source)).toContain('95.00%');
  });
});

describe('createFileOps', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'file-ops-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const seed = (relativePath: string, contents: string): void => {
    const target = join(root, relativePath);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };

  const read = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf-8');

  describe('rewrite', () => {
    it('writes the transformed content', () => {
      seed('README.md', 'old');

      createFileOps(root, false).rewrite('README.md', () => 'new');

      expect(read('README.md')).toBe('new');
    });

    // The flag the README tells users to preview with, and previously the only
    // thing tested about it was that parseArgs recognised the token.
    it('leaves the file alone on a dry run', () => {
      seed('README.md', 'old');

      createFileOps(root, true).rewrite('README.md', () => 'new');

      expect(read('README.md')).toBe('old');
    });

    it('records the action on a dry run all the same', () => {
      seed('README.md', 'old');

      const ops = createFileOps(root, true);
      ops.rewrite('README.md', () => 'new');

      expect(ops.actions()).toEqual([{ applied: true, kind: 'rewrite', path: 'README.md' }]);
    });

    it('skips a file that is not there and says so', () => {
      const ops = createFileOps(root, false);
      ops.rewrite('MISSING.md', () => 'new');

      expect(ops.actions()).toEqual([{ applied: false, kind: 'rewrite', path: 'MISSING.md' }]);
    });
  });

  describe('remove', () => {
    it('deletes the file', () => {
      seed('scripts/init.ts', 'x');

      createFileOps(root, false).remove('scripts/init.ts');

      expect(existsSync(join(root, 'scripts/init.ts'))).toBe(false);
    });

    it('leaves the file alone on a dry run', () => {
      seed('scripts/init.ts', 'x');

      createFileOps(root, true).remove('scripts/init.ts');

      expect(existsSync(join(root, 'scripts/init.ts'))).toBe(true);
    });

    it('records nothing for a file that was already absent', () => {
      const ops = createFileOps(root, false);
      ops.remove('scripts/gone.ts');

      expect(ops.actions()).toEqual([]);
    });
  });

  describe('removeDirectory', () => {
    it('deletes the directory and its contents', () => {
      seed('docs/lessons/tooling/one.md', 'x');

      createFileOps(root, false).removeDirectory('docs/lessons');

      expect(existsSync(join(root, 'docs/lessons'))).toBe(false);
    });

    it('prunes the parent when nothing else lived there', () => {
      seed('docs/lessons/tooling/one.md', 'x');

      createFileOps(root, false).removeDirectory('docs/lessons');

      expect(existsSync(join(root, 'docs'))).toBe(false);
    });

    it('keeps a parent that still holds something', () => {
      seed('docs/lessons/tooling/one.md', 'x');
      seed('docs/adr/0001.md', 'x');

      createFileOps(root, false).removeDirectory('docs/lessons');

      expect(existsSync(join(root, 'docs/adr/0001.md'))).toBe(true);
    });

    it('leaves everything in place on a dry run', () => {
      seed('docs/lessons/tooling/one.md', 'x');

      createFileOps(root, true).removeDirectory('docs/lessons');

      expect(existsSync(join(root, 'docs/lessons/tooling/one.md'))).toBe(true);
    });
  });
});
