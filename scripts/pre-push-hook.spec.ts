import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * Behavioural tests for `.husky/pre-push`.
 *
 * The hook is exercised the way husky invokes it — `sh -e .husky/pre-push` with
 * git's `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin —
 * against throwaway repositories on disk. Nothing is stubbed: a real bare repo
 * stands in for the remote, so "the remote has no main yet" is a genuine state
 * rather than a mocked return value.
 */

const HOOK_PATH = path.resolve(import.meta.dirname, '../.husky/pre-push');
const ZERO_SHA = '0'.repeat(40);

interface HookResult {
  /** Exit status of the hook process. */
  code: number;
  /** Contents of the hook's diagnostic log (its real output channel). */
  log: string;
}

interface Fixture {
  /** Working repository the hook runs inside. */
  local: string;
  /** Bare repository standing in for `origin`. */
  remote: string;
  /** Directory handed to the hook as `TMPDIR`, where it writes its log. */
  tmp: string;
  /** Directory prepended to `PATH`, holding the stubbed `pnpm`. */
  bin: string;
  /** Root of everything above, removed in `afterEach`. */
  root: string;
}

const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    // Capture stderr rather than inheriting it: git narrates branch switches and
    // pushes on stderr even when it succeeds, which would otherwise scatter
    // through the suite's output.
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const commit = (cwd: string, subject: string): string => {
  writeFileSync(path.join(cwd, 'file.txt'), `${subject}\n`);
  git(cwd, 'add', 'file.txt');
  git(cwd, 'commit', '-m', subject);
  return git(cwd, 'rev-parse', 'HEAD');
};

/**
 * Builds an isolated local + bare-remote pair with one commit on `main`.
 * The remote starts EMPTY — no refs at all — which is the state a freshly
 * created GitHub repository is in.
 */
const createFixture = (): Fixture => {
  const root = mkdtempSync(path.join(tmpdir(), 'pre-push-hook-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const tmp = path.join(root, 'tmp');
  const bin = path.join(root, 'bin');

  mkdirSync(remote);
  mkdirSync(local);
  mkdirSync(tmp);
  mkdirSync(bin);

  // The hook shells out to `pnpm run typecheck|lint|format:check|test:...` once
  // the git-level checks pass. Those are irrelevant here and cost minutes, so a
  // stub stands in — the tests assert on which checks the hook reaches, not on
  // what the real toolchain reports.
  const pnpmStub = path.join(bin, 'pnpm');
  writeFileSync(pnpmStub, '#!/bin/sh\nexit 0\n');
  chmodSync(pnpmStub, 0o755);

  git(remote, 'init', '--bare', '--initial-branch=main');
  git(local, 'init', '--initial-branch=main');
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test');
  git(local, 'remote', 'add', 'origin', remote);
  commit(local, 'chore: initial commit');

  return { bin, local, remote, root, tmp };
};

/**
 * Runs the hook and resolves with its exit code and log.
 *
 * `detached` puts the child in its own session so it has no controlling
 * terminal: the hook's `/dev/tty` probe then fails, and it neither spawns a
 * live `tail` nor spills the log into the terminal running the suite.
 */
const runHook = async (fixture: Fixture, pushRefs: string): Promise<HookResult> => {
  const child = spawn('sh', ['-e', HOOK_PATH], {
    cwd: fixture.local,
    detached: true,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
      TMPDIR: fixture.tmp,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end(pushRefs);

  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });

  return { code, log: readFileSync(path.join(fixture.tmp, 'husky-pre-push.log'), 'utf8') };
};

/** git's stdin line for a push that CREATES `ref` on the remote. */
const createRef = (ref: string, sha: string): string => `refs/heads/${ref} ${sha} refs/heads/${ref} ${ZERO_SHA}\n`;

/** git's stdin line for a push that UPDATES an existing `ref` on the remote. */
const updateRef = (ref: string, sha: string, remoteSha: string): string =>
  `refs/heads/${ref} ${sha} refs/heads/${ref} ${remoteSha}\n`;

describe('pre-push hook', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { force: true, recursive: true });
  });

  describe('branch protection', () => {
    it('blocks a direct push to a main that already exists on the remote', async () => {
      git(fixture.local, 'push', 'origin', 'main');
      const remoteSha = git(fixture.local, 'rev-parse', 'HEAD');
      const sha = commit(fixture.local, 'feat: second commit');

      const result = await runHook(fixture, updateRef('main', sha, remoteSha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Pushing directly to this branch is not allowed/);
    });

    // The deadlock this hook used to create: a brand-new remote has no `main`,
    // so the only way to seed it is a push from `main` — which the blanket
    // branch check refused, leaving no legal first push at all.
    it('allows a push from main that seeds a main the remote does not have', async () => {
      const sha = git(fixture.local, 'rev-parse', 'HEAD');

      const result = await runHook(fixture, createRef('main', sha));

      expect(result.code).toBe(0);
      expect(result.log).not.toMatch(/Pushing directly to this branch is not allowed/);
      expect(result.log).toMatch(/does not exist on the remote yet/);
    });

    // Without stdin there is no way to tell a seeding push from an ordinary
    // one, so the hook must keep refusing rather than guess in the user's
    // favour.
    it('still blocks a push from main when git supplied no ref lines', async () => {
      const result = await runHook(fixture, '');

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Pushing directly to this branch is not allowed/);
    });
  });

  describe('missing baseline', () => {
    it('pushes a feature branch when the remote has no main to compare against', async () => {
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commit(fixture.local, 'feat: a thing');

      const result = await runHook(fixture, createRef('feat/thing', sha));

      expect(result.code).toBe(0);
      expect(result.log).toMatch(/does not exist on 'origin' yet/);
    });

    it('runs the full gate when there is no baseline to diff against', async () => {
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commit(fixture.local, 'feat: a thing');

      const result = await runHook(fixture, createRef('feat/thing', sha));

      expect(result.code).toBe(0);
      expect(result.log).toMatch(/type-check passed/);
      expect(result.log).toMatch(/oxlint passed/);
      expect(result.log).toMatch(/All tests passed/);
      expect(result.log).not.toMatch(/skipping type-check/);
    });

    // A missing branch and an unreachable remote both make `git fetch` fail.
    // Only the first is safe to wave through.
    it('still fails when the remote itself is unreachable', async () => {
      git(fixture.local, 'remote', 'set-url', 'origin', path.join(fixture.root, 'does-not-exist.git'));
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commit(fixture.local, 'feat: a thing');

      const result = await runHook(fixture, createRef('feat/thing', sha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Failed to fetch latest changes/);
    });
  });

  describe('checks retained without a baseline', () => {
    it('blocks WIP commits on a seeding push', async () => {
      const sha = commit(fixture.local, 'wip: not ready');

      const result = await runHook(fixture, createRef('main', sha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/WIP \/ fixup! \/ squash! commits present/);
    });

    it('blocks a feature branch that is behind origin/main', async () => {
      git(fixture.local, 'push', 'origin', 'main');
      git(fixture.local, 'checkout', '-b', 'feat/stale');
      const stale = commit(fixture.local, 'feat: stale work');
      git(fixture.local, 'checkout', 'main');
      commit(fixture.local, 'feat: newer main work');
      git(fixture.local, 'push', 'origin', 'main');
      git(fixture.local, 'checkout', 'feat/stale');

      const result = await runHook(fixture, createRef('feat/stale', stale));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/is missing commits from 'origin\/main'/);
    });
  });
});
