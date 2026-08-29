import { writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { cleanupFixture, createFixture, type Fixture, readPnpmLog, runHook } from './husky-test-utils';

/**
 * Behavioural tests for `.husky/commit-msg`.
 *
 * The hook's only decision is which subjects to wave through without invoking
 * commitlint. Asserting the exit code alone cannot tell "skipped" from "ran and
 * passed", so every case also checks whether commitlint was reached — the
 * stubbed `pnpm` records that.
 */

const runCommitMsg = (fixture: Fixture, message: string) => {
  const messageFile = path.join(fixture.tmp, 'COMMIT_EDITMSG');

  writeFileSync(messageFile, `${message}\n`);

  return runHook(fixture, { args: [messageFile], hook: 'commit-msg' });
};

describe('commit-msg hook', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    cleanupFixture(fixture);
  });

  // git writes these subjects itself, so holding them to Conventional Commits
  // would block ordinary merges and rebases.
  describe('subjects git generates', () => {
    it.each([
      ['Merge branch "main" into feat/thing'],
      ['Revert "feat: a thing"'],
      ['fixup! feat: a thing'],
      ['squash! feat: a thing'],
      ['amend! feat: a thing'],
    ])('skips commitlint for %s', async (message) => {
      const result = await runCommitMsg(fixture, message);

      expect({ code: result.code, ranCommitlint: readPnpmLog(fixture).includes('commitlint') }).toEqual({
        code: 0,
        ranCommitlint: false,
      });
    });

    // The patterns match a prefix, so a subject that merely starts with a
    // similar word must still be linted.
    it('does not skip a subject that only looks generated', async () => {
      await runCommitMsg(fixture, 'Merged the thing');

      expect(readPnpmLog(fixture)).toContain('commitlint');
    });
  });

  describe('ordinary subjects', () => {
    it('passes the message file to commitlint', async () => {
      const result = await runCommitMsg(fixture, 'feat: ✨ a thing');

      expect({ code: result.code, log: readPnpmLog(fixture) }).toEqual({
        code: 0,
        log: expect.stringContaining('exec commitlint --edit'),
      });
    });

    it('rejects the commit when commitlint fails', async () => {
      const messageFile = path.join(fixture.tmp, 'COMMIT_EDITMSG');

      writeFileSync(messageFile, 'not a conventional commit\n');

      const result = await runHook(fixture, {
        args: [messageFile],
        env: { PNPM_FAIL: 'exec commitlint*' },
        hook: 'commit-msg',
      });

      expect(result.code).toBe(1);
    });
  });
});
