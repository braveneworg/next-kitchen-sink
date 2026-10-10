import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import packageJson from '../package.json' with { type: 'json' };

/**
 * `mise.toml` is the single place the Node and pnpm versions are pinned.
 *
 * Two other fields in `package.json` have to agree with it, because each is
 * read by a different tool: `packageManager` is what corepack installs, and
 * `engines.node` is what deployment platforms read — and what pnpm checks, but
 * only under `engineStrict`, which this project does not set. Three copies of
 * two version numbers drift the first time one is bumped by hand — and the
 * symptom is a contributor on a different toolchain than the one the gate ran
 * on, which nothing reports.
 *
 * `.nvmrc` used to be a fourth copy. It is gone on purpose; a version file
 * that mise does not read by default would be a pin that looks authoritative
 * and is not.
 */
const REPO_ROOT = path.join(import.meta.dirname, '..');

const MISE_TOML = path.join(REPO_ROOT, 'mise.toml');

/** An exact `major.minor.patch` — no range, no `latest`, no `lts`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** The `tool = "version"` lines for the two pinned tools, as mise writes them. */
const NODE_PIN = /^node\s*=\s*"([^"]*)"\s*$/m;
const PNPM_PIN = /^pnpm\s*=\s*"([^"]*)"\s*$/m;

/** The version `mise.toml` pins on the matching line, or an empty string. */
const pinnedVersion = (pin: RegExp): string => {
  const source = existsSync(MISE_TOML) ? readFileSync(MISE_TOML, 'utf8') : '';
  const [, version = ''] = pin.exec(source) ?? [];

  return version;
};

describe('toolchain pins', () => {
  it.each([
    ['node', NODE_PIN],
    ['pnpm', PNPM_PIN],
  ])('pins %s to an exact version in mise.toml', (_tool, pin) => {
    expect(pinnedVersion(pin)).toMatch(EXACT_VERSION);
  });

  it('pins the same pnpm in packageManager as in mise.toml', () => {
    const [packageManager] = packageJson.packageManager.split('+');

    expect(packageManager).toBe(`pnpm@${pinnedVersion(PNPM_PIN)}`);
  });

  it('sets the engines.node floor to the Node that mise.toml pins', () => {
    expect(packageJson.engines.node).toBe(`^${pinnedVersion(NODE_PIN)}`);
  });

  it('has no .nvmrc competing with mise.toml', () => {
    expect(existsSync(path.join(REPO_ROOT, '.nvmrc'))).toBe(false);
  });
});
