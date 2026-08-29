import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { cleanupFixture, createFixture, type Fixture, git, readPnpmLog, runHook } from './husky-test-utils';

/**
 * Behavioural tests for `.husky/post-merge`.
 *
 * The hook reinstalls dependencies when a merge touched the lockfile or
 * package.json. Its guard — "can I even determine the previous HEAD?" — is what
 * makes the rest reachable, so the first test pins that the guard fires ONLY in
 * the fixture that genuinely has no reflog entry. Without that, a fixture built
 * wrongly would take the early exit and every other test here would pass
 * vacuously.
 */

/** Commit a file, creating the HEAD@{1} reflog entry post-merge needs. */
const commitFile = (fixture: Fixture, relativePath: string, contents: string): void => {
  const target = path.join(fixture.local, relativePath);

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  git(fixture.local, 'add', relativePath);
  git(fixture.local, 'commit', '-m', `chore: touch ${relativePath}`);
};

describe('post-merge hook', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    cleanupFixture(fixture);
  });

  // createFixture makes exactly one commit, so the reflog holds a single entry
  // and HEAD@{1} does not resolve.
  it('exits quietly when the previous HEAD cannot be determined', async () => {
    const result = await runHook(fixture, { hook: 'post-merge' });

    expect({ code: result.code, log: readPnpmLog(fixture) }).toEqual({ code: 0, log: '' });
  });

  it('reinstalls dependencies when the lockfile changed', async () => {
    commitFile(fixture, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');

    const result = await runHook(fixture, { hook: 'post-merge' });

    expect({ code: result.code, log: readPnpmLog(fixture) }).toEqual({
      code: 0,
      log: expect.stringContaining('install'),
    });
  });

  it('reinstalls dependencies when package.json changed', async () => {
    commitFile(fixture, 'package.json', '{ "name": "fixture" }\n');

    expect(readPnpmLog(fixture)).toBe('');

    await runHook(fixture, { hook: 'post-merge' });

    expect(readPnpmLog(fixture)).toContain('install');
  });

  it('does nothing when only source changed', async () => {
    commitFile(fixture, 'src/thing.ts', 'export const x = 1;\n');

    const result = await runHook(fixture, { hook: 'post-merge' });

    expect({ code: result.code, log: readPnpmLog(fixture) }).toEqual({ code: 0, log: '' });
  });

  // The grep is anchored, so a lockfile nested somewhere else is not this
  // repository's lockfile and must not trigger a reinstall.
  it('ignores a lockfile in a subdirectory', async () => {
    commitFile(fixture, 'vendor/pnpm-lock.yaml', 'lockfileVersion: 9.0\n');

    expect(readPnpmLog(fixture)).toBe('');

    await runHook(fixture, { hook: 'post-merge' });

    expect(readPnpmLog(fixture)).toBe('');
  });
});
