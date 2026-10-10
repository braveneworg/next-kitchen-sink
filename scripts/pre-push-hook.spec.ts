import * as path from 'node:path';

import {
  cleanupFixture,
  commit,
  commitFile,
  createFixture,
  createRef,
  deleteRef,
  type Fixture,
  git,
  type HookResult,
  readPnpmLog,
  runHook,
  updateRef,
  updateRefAs,
} from './husky-test-utils';

/**
 * Behavioural tests for `.husky/pre-push`.
 *
 * The hook is exercised the way husky invokes it — `sh -e .husky/pre-push` with
 * git's `<local ref> <local sha> <remote ref> <remote sha>` lines on stdin —
 * against throwaway repositories on disk. Nothing is stubbed except the
 * toolchain: a real bare repo stands in for the remote, so "the remote has no
 * main yet" is a genuine state rather than a mocked return value.
 */

/** Invoke the hook exactly as git does: `pre-push <remote-name> <remote-url>`. */
const runPrePush = (fixture: Fixture, stdin: string): Promise<HookResult> =>
  runHook(fixture, {
    args: ['origin', git(fixture.local, 'remote', 'get-url', 'origin')],
    hook: 'pre-push',
    stdin,
  });

/** Every `pnpm` invocation the full gate makes, in the order it makes them. */
const FULL_GATE: readonly string[] = ['run typecheck', 'run lint', 'run format:check', 'run test:coverage:check'];

/** The stubbed `pnpm`'s invocations, one per element. Empty when it never ran. */
const pnpmCalls = (fixture: Fixture): string[] => readPnpmLog(fixture).split('\n').filter(Boolean);

describe('pre-push hook', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    cleanupFixture(fixture);
  });

  describe('branch protection', () => {
    it('blocks a direct push to a main that already exists on the remote', async () => {
      git(fixture.local, 'push', 'origin', 'main');
      const remoteSha = git(fixture.local, 'rev-parse', 'HEAD');
      const sha = commit(fixture.local, 'feat: second commit');

      const result = await runPrePush(fixture, updateRef('main', sha, remoteSha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Pushing directly to this branch is not allowed/);
    });

    // The deadlock this hook used to create: a brand-new remote has no `main`,
    // so the only way to seed it is a push from `main` — which the blanket
    // branch check refused, leaving no legal first push at all.
    it('allows a push from main that seeds a remote with no refs at all', async () => {
      const sha = git(fixture.local, 'rev-parse', 'HEAD');

      const result = await runPrePush(fixture, createRef('main', sha));

      expect(result.code).toBe(0);
      expect(result.log).not.toMatch(/Pushing directly to this branch is not allowed/);
      expect(result.log).toMatch(/has no refs at all/);
    });

    // The exception is for bootstrapping an unseeded repository, NOT for "this
    // particular branch happens to be missing". Deleting main on the forge must
    // not re-open direct pushes to it — an all-zero remote sha alone cannot
    // tell those apart, so the remote itself has to be inspected.
    it('blocks a push from main after main was deleted on a remote that still has refs', async () => {
      git(fixture.local, 'push', 'origin', 'main');
      git(fixture.local, 'push', 'origin', 'main:refs/heads/develop');
      // A repository refuses to delete the branch its HEAD points at, so the
      // default has to move first — the same order a forge imposes.
      git(fixture.remote, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
      git(fixture.local, 'push', 'origin', '--delete', 'main');
      const sha = git(fixture.local, 'rev-parse', 'HEAD');

      const result = await runPrePush(fixture, createRef('main', sha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Pushing directly to this branch is not allowed/);
    });

    // An unreachable remote must never be mistaken for an unseeded one — that
    // would let a network blip unlock direct pushes to main.
    it('fails when the remote is unreachable while checking whether it is unseeded', async () => {
      git(fixture.local, 'remote', 'set-url', 'origin', path.join(fixture.root, 'does-not-exist.git'));
      const sha = git(fixture.local, 'rev-parse', 'HEAD');

      const result = await runPrePush(fixture, createRef('main', sha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Could not reach 'origin'/);
    });

    // Without stdin there is no way to tell a seeding push from an ordinary
    // one, so the hook must keep refusing rather than guess in the user's
    // favour.
    it('still blocks a push from main when git supplied no ref lines', async () => {
      const result = await runPrePush(fixture, '');

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Pushing directly to this branch is not allowed/);
    });

    // The check used to ask only "which branch is checked out?". git pushes
    // whatever the refspec names, so `git push origin feat/thing:main` updated
    // main from a branch that was never main, and nothing objected.
    it('blocks a push that updates main from a feature branch by refspec', async () => {
      git(fixture.local, 'push', 'origin', 'main');
      const remoteSha = git(fixture.local, 'rev-parse', 'HEAD');
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commit(fixture.local, 'feat: a thing');

      const result = await runPrePush(fixture, updateRefAs('feat/thing', sha, 'main', remoteSha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/This push updates 'main' on 'origin'/);
    });

    // The seeding exception is about the remote, not about which local branch
    // carries the first commit, so it has to survive the refspec form too.
    it('allows a refspec push that seeds main on a remote with no refs at all', async () => {
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = git(fixture.local, 'rev-parse', 'HEAD');

      const result = await runPrePush(fixture, updateRefAs('feat/thing', sha, 'main', '0'.repeat(40)));

      expect(result.code).toBe(0);
      expect(result.log).toMatch(/has no refs at all/);
    });
  });

  // A deletion carries no commits, so there is no tree to type-check, lint or
  // test — and none of the checks below can say anything about it. The hook used
  // to run them anyway against whatever happened to be checked out, which from
  // `main` meant refusing outright: tidying up a merged branch was impossible
  // without first switching to some other branch.
  describe('ref deletion', () => {
    /** Push main and a feature branch, leaving the feature branch checked out. */
    const pushFeatureBranch = (): string => {
      git(fixture.local, 'push', 'origin', 'main');
      git(fixture.local, 'checkout', '-b', 'feat/gone');
      const sha = commit(fixture.local, 'feat: soon to be merged');
      git(fixture.local, 'push', 'origin', 'feat/gone');
      return sha;
    };

    it('allows deleting a feature branch while main is checked out', async () => {
      const remoteSha = pushFeatureBranch();
      git(fixture.local, 'checkout', 'main');

      const result = await runPrePush(fixture, deleteRef('feat/gone', remoteSha));

      expect(result.code).toBe(0);
      expect(result.log).toMatch(/Only deleting/);
    });

    it('runs no gate for a push that only deletes', async () => {
      const remoteSha = pushFeatureBranch();

      const result = await runPrePush(fixture, deleteRef('feat/gone', remoteSha));

      expect({ code: result.code, pnpm: pnpmCalls(fixture) }).toEqual({ code: 0, pnpm: [] });
    });

    // Skipping the checks for a deletion must not become a way to remove the
    // branch the checks exist to protect.
    it.each([['main'], ['feat/gone']])('refuses to delete main while %s is checked out', async (checkedOut) => {
      pushFeatureBranch();
      git(fixture.local, 'checkout', checkedOut);
      const mainSha = git(fixture.local, 'rev-parse', 'main');

      const result = await runPrePush(fixture, deleteRef('main', mainSha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Deleting 'main' on 'origin' is not allowed/);
    });

    // Only a push made of deletions and nothing else is exempt. One that also
    // carries commits is an ordinary push with a deletion attached.
    it('still runs the full gate when a push deletes one branch and updates another', async () => {
      const remoteSha = pushFeatureBranch();
      git(fixture.local, 'checkout', '-b', 'feat/next', 'main');
      const sha = commit(fixture.local, 'feat: the next thing');

      const result = await runPrePush(fixture, deleteRef('feat/gone', remoteSha) + createRef('feat/next', sha));

      expect({ code: result.code, pnpm: pnpmCalls(fixture) }).toEqual({ code: 0, pnpm: FULL_GATE });
    });
  });

  // The hook used to run the gate only when a `.ts` or `.tsx` file differed from
  // the baseline. Every other file was assumed to be inert, and almost none
  // are: the lockfile decides what the compiler and the tests resolve, the
  // coverage gate parses COVERAGE_METRICS.md, Prettier checks Markdown and JSON,
  // and the hook specs execute `.husky/*`. A dependency bump — the change most
  // likely to break types or tests without touching a line of source — was
  // pushed with nothing run at all.
  describe('gate selection', () => {
    it.each([
      ['pnpm-lock.yaml'],
      ['package.json'],
      ['pnpm-workspace.yaml'],
      ['COVERAGE_METRICS.md'],
      ['.husky/pre-push'],
      ['src/app/globals.css'],
      ['src/lib/thing.ts'],
    ])('runs the full gate when only %s changed', async (file) => {
      git(fixture.local, 'push', 'origin', 'main');
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commitFile(fixture.local, file, 'chore: change one file');

      const result = await runPrePush(fixture, createRef('feat/thing', sha));

      expect({ code: result.code, pnpm: pnpmCalls(fixture) }).toEqual({ code: 0, pnpm: FULL_GATE });
    });
  });

  describe('missing baseline', () => {
    it('pushes a feature branch when the remote has no main to compare against', async () => {
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commit(fixture.local, 'feat: a thing');

      const result = await runPrePush(fixture, createRef('feat/thing', sha));

      expect(result.code).toBe(0);
      expect(result.log).toMatch(/does not exist on 'origin' yet/);
    });

    // Deliberately NOT narrowed the way branch protection is. Branch protection
    // asks "may I?", and a missing main is too weak a licence. This asks "what
    // do I compare against?", and a missing main leaves genuinely nothing —
    // whether or not the remote holds other refs.
    it('pushes a feature branch when the remote has refs but no main', async () => {
      git(fixture.local, 'push', 'origin', 'main:refs/heads/develop');
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commit(fixture.local, 'feat: a thing');

      const result = await runPrePush(fixture, createRef('feat/thing', sha));

      expect(result.code).toBe(0);
      expect(result.log).toMatch(/does not exist on 'origin' yet/);
    });

    it('runs the full gate when there is no baseline to diff against', async () => {
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commit(fixture.local, 'feat: a thing');

      const result = await runPrePush(fixture, createRef('feat/thing', sha));

      expect(result.code).toBe(0);
      expect(result.log).toMatch(/type-check passed/);
      expect(result.log).toMatch(/oxlint passed/);
      // Matches both the current "✅ All tests passed" and the shorter wording
      // the shared failure/success template produces, so the migration to
      // `.husky/lib.sh` needs no edit here. If this assertion ever has to
      // change, behaviour changed — not just phrasing.
      expect(result.log).toMatch(/tests passed/);
      expect(result.log).not.toMatch(/skipping type-check/);
    });

    // A missing branch and an unreachable remote both make `git fetch` fail.
    // Only the first is safe to wave through.
    it('still fails when the remote itself is unreachable', async () => {
      git(fixture.local, 'remote', 'set-url', 'origin', path.join(fixture.root, 'does-not-exist.git'));
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      const sha = commit(fixture.local, 'feat: a thing');

      const result = await runPrePush(fixture, createRef('feat/thing', sha));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/Failed to fetch latest changes/);
    });
  });

  describe('checks retained without a baseline', () => {
    it('blocks WIP commits on a seeding push', async () => {
      const sha = commit(fixture.local, 'wip: not ready');

      const result = await runPrePush(fixture, createRef('main', sha));

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

      const result = await runPrePush(fixture, createRef('feat/stale', stale));

      expect(result.code).toBe(1);
      expect(result.log).toMatch(/is missing commits from 'origin\/main'/);
    });
  });

  // Every gate the hook runs, driven red. The old stub exited 0 for everything,
  // so none of these four branches had ever been executed — the same "only ever
  // observed passing" state that hid the tsc-files bug for months.
  describe('gate failures', () => {
    // Leaves the remote unseeded, which is the shortest route to the gate: with
    // no `origin/main` there is no up-to-date check to satisfy first.
    const seedFeatureBranch = (): string => {
      git(fixture.local, 'checkout', '-b', 'feat/thing');
      return commit(fixture.local, 'feat: a thing');
    };

    it.each([
      ['run typecheck', /type-check/i],
      ['run lint', /lint/i],
      ['run format:check', /format/i],
      ['run test:coverage:check', /test/i],
    ])('fails the push when `pnpm %s` fails', async (command, expected) => {
      const sha = seedFeatureBranch();

      const result = await runHook(fixture, {
        args: ['origin', git(fixture.local, 'remote', 'get-url', 'origin')],
        env: { PNPM_FAIL: `${command}*` },
        hook: 'pre-push',
        stdin: createRef('feat/thing', sha),
      });

      expect({ code: result.code, matched: expected.test(result.log ?? '') }).toEqual({ code: 1, matched: true });
    });

    // pnpm appends run-args to the END of the script string, and
    // `test:coverage:check` is `vitest run --coverage && tsx …`, so any flags
    // passed here land on the tsx invocation, which ignores them. Passing them
    // at all is a silent no-op that reads like configuration.
    it('runs the coverage gate with no trailing reporter flags', async () => {
      const sha = seedFeatureBranch();

      await runPrePush(fixture, createRef('feat/thing', sha));

      const log = readPnpmLog(fixture);

      expect(log).toContain('run test:coverage:check');
      expect(log).not.toMatch(/--reporter=dot|--silent/);
    });
  });
});
