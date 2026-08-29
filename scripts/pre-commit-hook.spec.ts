import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  cleanupFixture,
  createFixture,
  createUnbornFixture,
  type Fixture,
  git,
  readPnpmLog,
  restrictedPath,
  runHook,
  type RunHookOptions,
  stub,
} from './husky-test-utils';

/**
 * Behavioural tests for `.husky/pre-commit`.
 *
 * This hook had none, and it is the one that performs a destructive side
 * effect: `git reset` when it refuses a commit on a protected branch.
 */

/** Write a file into the fixture repo and stage it. */
const stageFile = (fixture: Fixture, relativePath: string, contents = 'export const x = 1;\n'): void => {
  const target = path.join(fixture.local, relativePath);

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  git(fixture.local, 'add', relativePath);
};

const runPreCommit = (fixture: Fixture, options: Partial<RunHookOptions> = {}) =>
  runHook(fixture, {
    hook: 'pre-commit',
    // gitleaks is probed with `command -v`. A developer machine that has it
    // installed would otherwise take a different branch than CI, so the search
    // path is pinned and the tool is stubbed in explicitly when wanted.
    path: restrictedPath(fixture),
    ...options,
  });

describe('pre-commit hook', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
    git(fixture.local, 'checkout', '-b', 'feat/thing');
  });

  afterEach(() => {
    cleanupFixture(fixture);
  });

  describe('branch protection', () => {
    it('refuses a commit on main', async () => {
      git(fixture.local, 'checkout', 'main');
      stageFile(fixture, 'src/thing.ts');

      const result = await runPreCommit(fixture);

      expect(result.code).toBe(1);
    });

    // The destructive part, and the reason this file exists: refusing the
    // commit also unstages everything. Pinned explicitly so it can never become
    // an accident.
    it('unstages the work it refuses', async () => {
      git(fixture.local, 'checkout', 'main');
      stageFile(fixture, 'src/thing.ts');

      await runPreCommit(fixture);

      expect(git(fixture.local, 'diff', '--cached', '--name-only')).toBe('');
    });

    it('allows a commit on a feature branch', async () => {
      stageFile(fixture, 'src/thing.ts');

      expect((await runPreCommit(fixture)).code).toBe(0);
    });
  });

  describe('preconditions', () => {
    it('refuses a commit with nothing staged', async () => {
      expect((await runPreCommit(fixture)).code).toBe(1);
    });

    // git passes no arguments to pre-commit, so the `--amend` skip this hook
    // used to carry could never fire. Pinned as an argument the hook ignores,
    // so nobody reintroduces the branch believing it worked.
    it('runs the checks even when handed an --amend argument', async () => {
      stageFile(fixture, 'src/thing.ts');

      const result = await runPreCommit(fixture, { args: ['--amend'] });

      expect({ code: result.code, ranTests: /exec vitest run/.test(readPnpmLog(fixture)) }).toEqual({
        code: 0,
        ranTests: true,
      });
    });
  });

  describe('secret scanning', () => {
    it('continues when gitleaks is not installed', async () => {
      stageFile(fixture, 'src/thing.ts');

      const result = await runPreCommit(fixture);

      expect(result.code).toBe(0);
    });

    it('refuses the commit when gitleaks reports a leak', async () => {
      stub(fixture, 'gitleaks', 'exit 1');
      stageFile(fixture, 'src/thing.ts');

      expect((await runPreCommit(fixture)).code).toBe(1);
    });

    it('continues when gitleaks finds nothing', async () => {
      stub(fixture, 'gitleaks', 'exit 0');
      stageFile(fixture, 'src/thing.ts');

      expect((await runPreCommit(fixture)).code).toBe(0);
    });
  });

  describe('gates', () => {
    it('refuses the commit when lint-staged fails', async () => {
      stageFile(fixture, 'src/thing.ts');

      const result = await runPreCommit(fixture, { env: { PNPM_FAIL: 'exec lint-staged*' } });

      expect(result.code).toBe(1);
    });

    it('refuses the commit when the changed-file tests fail', async () => {
      stageFile(fixture, 'src/thing.ts');

      const result = await runPreCommit(fixture, { env: { PNPM_FAIL: 'exec vitest*' } });

      expect(result.code).toBe(1);
    });

    it('runs the changed-file tests for a source file', async () => {
      stageFile(fixture, 'src/thing.ts');

      await runPreCommit(fixture);

      expect(readPnpmLog(fixture)).toMatch(/exec vitest run/);
    });

    // A commit that touches only spec files is exactly the commit whose test
    // behaviour changed, and it was the one commit that ran no tests at all:
    // the changed-file filter drops anything matching `.spec.` before asking
    // whether the list is empty.
    it('runs the tests for a commit that touches only spec files', async () => {
      stageFile(fixture, 'src/thing.spec.ts');

      await runPreCommit(fixture);

      expect(readPnpmLog(fixture)).toMatch(/exec vitest run/);
    });

    it('skips the tests when no TypeScript changed', async () => {
      stageFile(fixture, 'docs/notes.md', '# notes\n');

      await runPreCommit(fixture);

      expect(readPnpmLog(fixture)).not.toMatch(/exec vitest run/);
    });

    // `vitest --changed` diffs the module graph, which cannot see a shell
    // script — so editing a hook used to run none of the specs that cover it,
    // the same blind spot as the spec filter one level out.
    it('runs the hook specs when a hook itself changed', async () => {
      stageFile(fixture, '.husky/pre-push', '#!/bin/sh\nexit 0\n');

      await runPreCommit(fixture);

      expect(readPnpmLog(fixture)).toMatch(/exec vitest run scripts/);
    });

    it('does not run the hook specs when no hook changed', async () => {
      stageFile(fixture, 'src/thing.ts');

      await runPreCommit(fixture);

      expect(readPnpmLog(fixture)).not.toMatch(/exec vitest run scripts/);
    });
  });

  describe('the very first commit', () => {
    let unborn: Fixture;

    beforeEach(() => {
      unborn = createUnbornFixture();
    });

    afterEach(() => {
      cleanupFixture(unborn);
    });

    // `vitest --changed HEAD` needs a HEAD to diff against; without one it
    // exits 128 and the initial commit becomes impossible.
    //
    // On a feature branch, because pre-commit refuses `main` with no seeding
    // exception — so the first commit of a repository is only ever legal off
    // main. That is consistent with this repo's "never commit to main" rule,
    // but note it means the comment at pre-commit:11-15, which frames
    // --show-current as what makes the first commit possible, only holds once
    // you have branched.
    it('runs the whole suite rather than a --changed scope', async () => {
      git(unborn.local, 'checkout', '-b', 'feat/thing');
      stageFile(unborn, 'src/thing.ts');

      const result = await runHook(unborn, { hook: 'pre-commit', path: restrictedPath(unborn) });

      expect({ code: result.code, log: readPnpmLog(unborn) }).toEqual({
        code: 0,
        log: expect.stringMatching(/exec vitest run\s*$/m),
      });
    });
  });
});
