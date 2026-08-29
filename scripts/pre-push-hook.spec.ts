import * as path from 'node:path';

import {
  cleanupFixture,
  commit,
  createFixture,
  createRef,
  type Fixture,
  git,
  type HookResult,
  readPnpmLog,
  runHook,
  updateRef,
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
    // Deliberately leaves the remote unseeded. With no baseline to diff
    // against, the hook runs the full gate rather than taking the
    // "no TypeScript changed" shortcut — which is what these tests need to
    // reach. Pushing main first would give it a baseline, and the fixture's
    // commits touch no .ts files, so every gate would be skipped.
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
