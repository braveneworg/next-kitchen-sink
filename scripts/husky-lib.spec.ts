import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { cleanGitEnv, cleanupFixture, createFixture, type Fixture, git, HUSKY_DIR } from './husky-test-utils';

/**
 * Unit tests for `.husky/lib.sh`.
 *
 * The library is sourced into three different option regimes — pre-commit runs
 * `set -e`, pre-push runs `set +e`, commit-msg sets neither — so every
 * behavioural assertion runs under all three, in both `sh` and `dash`. That
 * table IS the contract: a helper that returns non-zero from a bare call, or
 * lets a child's stdout into a captured token, fails in one regime and not
 * another, and this is what catches it.
 */

const LIB_PATH = path.join(HUSKY_DIR, 'lib.sh');
const HAS_DASH = existsSync('/bin/dash');

interface SnippetResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface SnippetOptions {
  shell?: string;
  /** `-e`, `+e`, or undefined for "hook sets no option at all". */
  setOption?: string;
  cwd?: string;
  /** Positional parameters, to prove sourcing does not disturb `$@`. */
  args?: readonly string[];
}

const runSnippet = (snippet: string, options: SnippetOptions = {}): SnippetResult => {
  const prelude = options.setOption === undefined ? '' : `set ${options.setOption}\n`;
  const script = `${prelude}. '${LIB_PATH}'\n${snippet}\n`;
  const result = spawnSync(options.shell ?? 'sh', ['-c', script, 'hook-under-test', ...(options.args ?? [])], {
    cwd: options.cwd ?? HUSKY_DIR,
    encoding: 'utf8',
    env: cleanGitEnv(),
  });

  return { code: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
};

/** Every option regime the library is actually sourced into. */
const REGIMES: readonly [string, string, string | undefined][] = [
  ['sh, set -e', 'sh', '-e'],
  ['sh, set +e', 'sh', '+e'],
  ['sh, no option', 'sh', undefined],
  ...(HAS_DASH
    ? ([
        ['dash, set -e', 'dash', '-e'],
        ['dash, set +e', 'dash', '+e'],
        ['dash, no option', 'dash', undefined],
      ] as [string, string, string | undefined][])
    : []),
];

describe.each(REGIMES)('under %s', (_label, shell, setOption) => {
  const run = (snippet: string, options: SnippetOptions = {}): SnippetResult =>
    runSnippet(snippet, { setOption, shell, ...options });

  describe('sourcing', () => {
    it('defines the helpers without setting anything or exiting', () => {
      expect(run('printf ok\n').code).toBe(0);
    });

    it('is a no-op when sourced twice', () => {
      const result = run(`. '${LIB_PATH}'\nprintf twice\n`);

      expect({ code: result.code, stdout: result.stdout }).toEqual({ code: 0, stdout: 'twice' });
    });

    // `.` with no extra arguments must leave the caller's positional parameters
    // alone, or pre-push's `push_remote="${1:-origin}"` and commit-msg's
    // `COMMIT_MSG_FILE="$1"` would read the library's arguments instead.
    it('leaves the positional parameters untouched', () => {
      const result = run('printf "%s|%s|%s" "$#" "$1" "$2"\n', { args: ['origin', 'git@example.com:x.git'] });

      expect(result.stdout).toBe('2|origin|git@example.com:x.git');
    });
  });

  describe('is_protected_branch', () => {
    it.each([
      ['main', 0],
      ['master', 0],
      ['feat/thing', 1],
      ['', 1],
      ['MAIN', 1],
      ['main-ish', 1],
      ['mainline', 1],
    ])('answers %s with %s', (branch, expected) => {
      expect(run(`if is_protected_branch '${branch}'; then printf yes; else printf no; fi\n`).stdout).toBe(
        expected === 0 ? 'yes' : 'no'
      );
    });
  });

  describe('diagnostics', () => {
    it('sends info to stdout only', () => {
      const result = run('info "hello"\n');

      expect({ err: result.stderr, out: result.stdout.includes('hello') }).toEqual({ err: '', out: true });
    });

    it('sends warn to stderr only', () => {
      const result = run('warn "careful"\n');

      expect({ err: result.stderr.includes('careful'), out: result.stdout }).toEqual({ err: true, out: '' });
    });

    it('indents continuation lines', () => {
      expect(run('info "headline" "detail one" "detail two"\n').stdout).toContain('   detail one\n   detail two\n');
    });

    // macOS /bin/sh expands backslash escapes in `echo`, so a commit subject or
    // branch name containing one would render differently here than on Linux.
    // printf is why this passes in every regime.
    it('prints a backslash sequence literally', () => {
      expect(run('info "a\\nb"\n').stdout).toContain('a\\nb');
    });

    it('prints a leading-dash message literally', () => {
      expect(run('info "-n not a flag"\n').stdout).toContain('-n not a flag');
    });

    it.each([
      ['refuse', '🚫'],
      ['fail', '❌'],
    ])('%s exits 1 and writes to stderr', (fn, emoji) => {
      const result = run(`${fn} "no" "because"\nprintf UNREACHABLE\n`);

      expect({
        code: result.code,
        emoji: result.stderr.includes(emoji),
        reached: result.stdout.includes('UNREACHABLE'),
      }).toEqual({ code: 1, emoji: true, reached: false });
    });
  });

  describe('run_gate', () => {
    it('reports success and continues', () => {
      const result = run('run_gate "type-check" "" true\nprintf AFTER\n');

      expect({ code: result.code, out: result.stdout }).toEqual({
        code: 0,
        out: expect.stringContaining('✅ type-check passed'),
      });
      expect(result.stdout).toContain('AFTER');
    });

    it('fails the hook and names the remedy', () => {
      const result = run('run_gate "linting" "pnpm run lint" false\nprintf UNREACHABLE\n');

      expect({
        code: result.code,
        reached: result.stdout.includes('UNREACHABLE'),
        remedy: result.stderr.includes("Run 'pnpm run lint'"),
      }).toEqual({ code: 1, reached: false, remedy: true });
    });

    it('falls back to the command itself when no remedy is given', () => {
      expect(run('run_gate "checking" "" false alpha beta\n').stderr).toContain("Run 'false alpha beta'");
    });

    // The command is real argv. Nothing may be re-split on whitespace, and
    // nothing may be appended — the bug this replaces was pnpm silently
    // receiving two extra run-args at the end of a script string.
    it('passes the command through as argv, unsplit and unappended', () => {
      const result = run(`run_gate "echoing" "" printf '%s|' "$#" 'one two' three\n`, { args: [] });

      expect(result.stdout).toContain('0|one two|three|');
    });
  });
});

describe('git-backed helpers', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    cleanupFixture(fixture);
  });

  const inRepo = (snippet: string): SnippetResult => runSnippet(snippet, { cwd: fixture.local });

  describe('current_branch', () => {
    it('prints the checked-out branch', () => {
      expect(inRepo('current_branch\n').stdout.trim()).toBe('main');
    });

    it('prints a feature branch', () => {
      git(fixture.local, 'checkout', '-b', 'feat/thing');

      expect(inRepo('current_branch\n').stdout.trim()).toBe('feat/thing');
    });

    // rev-parse --abbrev-ref HEAD exits 128 here, which under `set -e` aborted
    // the hook and made the first commit of a repository impossible.
    it('survives an unborn branch under set -e', () => {
      const empty = path.join(fixture.root, 'unborn');

      git(fixture.root, 'init', 'unborn');

      const result = runSnippet('current_branch\nprintf AFTER\n', { cwd: empty, setOption: '-e' });

      expect({ code: result.code, reached: result.stdout.includes('AFTER') }).toEqual({ code: 0, reached: true });
    });

    // The rev-parse fallback exists for exactly this: pre-push's messages quote
    // the branch, and "HEAD" is more use than an empty string.
    it('prints HEAD when detached', () => {
      const sha = git(fixture.local, 'rev-parse', 'HEAD');
      git(fixture.local, 'checkout', sha);

      expect(inRepo('current_branch\n').stdout.trim()).toBe('HEAD');
    });
  });

  describe('remote_state', () => {
    it('reports an unseeded remote as empty', () => {
      expect(inRepo('remote_state origin\n').stdout.trim()).toBe('empty');
    });

    it('reports a remote with refs as populated', () => {
      git(fixture.local, 'push', 'origin', 'main');

      expect(inRepo('remote_state origin\n').stdout.trim()).toBe('populated');
    });

    // An unreachable remote must never read as an unseeded one — that would
    // turn a network blip into an unlocked main.
    it('reports an unreachable remote as unreachable', () => {
      git(fixture.local, 'remote', 'set-url', 'origin', path.join(fixture.root, 'nope.git'));

      expect(inRepo('remote_state origin\n').stdout.trim()).toBe('unreachable');
    });
  });

  describe('fetch_branch', () => {
    it('reports a successful fetch as fetched', () => {
      git(fixture.local, 'push', 'origin', 'main');

      expect(inRepo('fetch_branch origin main\n').stdout.trim()).toBe('fetched');
    });

    it('reports a reachable remote without the branch as absent', () => {
      git(fixture.local, 'push', 'origin', 'main:refs/heads/develop');

      expect(inRepo('fetch_branch origin main\n').stdout.trim()).toBe('absent');
    });

    it('reports an unreachable remote as unreachable', () => {
      git(fixture.local, 'remote', 'set-url', 'origin', path.join(fixture.root, 'nope.git'));

      expect(inRepo('fetch_branch origin main\n').stdout.trim()).toBe('unreachable');
    });

    // git fetch narrates on stdout in some configurations. If any of it reached
    // fd 1 the token would be corrupted and every `case` over it would fall
    // through to the strict arm.
    it('emits the token and nothing else', () => {
      git(fixture.local, 'push', 'origin', 'main');

      expect(inRepo('state=$(fetch_branch origin main)\nprintf "[%s]" "$state"\n').stdout).toBe('[fetched]');
    });
  });
});
