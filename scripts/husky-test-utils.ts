/**
 * Shared harness for the husky hook specs.
 *
 * Deliberately NOT a `.spec.ts` file — vitest's `node` project collects
 * `**\/*.spec.ts`, and this module holds no tests of its own.
 *
 * Hooks are exercised the way husky invokes them: `sh -e .husky/<name>` with
 * git's arguments forwarded, against throwaway repositories on disk. Nothing is
 * mocked — a real bare repo stands in for the remote, so "the remote has no
 * main yet" is a genuine state rather than a stubbed return value.
 */

import { execFileSync, spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Directory holding the real hooks under test. */
export const HUSKY_DIR = path.resolve(import.meta.dirname, '../.husky');

/** git's all-zero sha, meaning "this ref does not exist on the other side". */
export const ZERO_SHA = '0'.repeat(40);

export interface Fixture {
  /** Working repository the hook runs inside. */
  local: string;
  /** Bare repository standing in for `origin`. */
  remote: string;
  /** Directory handed to the hook as `TMPDIR`, where it writes its log. */
  tmp: string;
  /** Directory prepended to `PATH`, holding the stubbed executables. */
  bin: string;
  /** File the stubbed `pnpm` appends each invocation's arguments to. */
  pnpmLog: string;
  /** Root of everything above, removed by `cleanupFixture`. */
  root: string;
}

export interface HookResult {
  /** Exit status of the hook process. */
  code: number;
  /** Anything the hook wrote to stdout. */
  stdout: string;
  /** Anything the hook wrote to stderr. */
  stderr: string;
  /**
   * Contents of the hook's diagnostic log, for hooks that write one. `pre-push`
   * redirects itself into a log and replays it; the others report on git's own
   * stdout/stderr, so this is `null` for them.
   */
  log: string | null;
}

export interface RunHookOptions {
  /** Hook filename under `.husky/`, e.g. `pre-push`. */
  hook: string;
  /** Arguments git would pass. `pre-push` gets `<remote-name> <remote-url>`. */
  args?: readonly string[];
  /** Text written to the hook's stdin. `pre-push` reads its ref lines here. */
  stdin?: string;
  /** Extra environment for the hook and everything it spawns. */
  env?: Readonly<Record<string, string>>;
  /**
   * Replaces `PATH` entirely rather than prepending the fixture's `bin`. Use to
   * make a tool's ABSENCE deterministic — the hook probes for `gitleaks` with
   * `command -v`, and a developer machine that has it installed would otherwise
   * take a different branch than CI.
   */
  path?: string;
}

/** A `PATH` containing the fixture's stubs and the base system tools only. */
export const restrictedPath = (fixture: Fixture): string => `${fixture.bin}:/usr/bin:/bin`;

/**
 * `process.env` with every `GIT_*` variable removed.
 *
 * git exports `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_PREFIX` and friends to the
 * hooks it invokes. When this suite runs from inside a hook — pre-commit shells
 * out to `vitest run --changed` — those leak into the fixture's own git calls,
 * so `git init` in a throwaway directory silently addresses THE REAL
 * REPOSITORY: `git remote add origin` then fails with "remote origin already
 * exists" because it is talking about this repo, not the fixture.
 *
 * `.husky/pre-push:68-70` unsets the same set for the same reason. The two
 * config vars are re-applied afterwards so a developer's global gitconfig
 * cannot influence a fixture either.
 */
export const cleanGitEnv = (): NodeJS.ProcessEnv => {
  // Copied and pruned rather than rebuilt from entries: Next augments
  // `NodeJS.ProcessEnv` with a required `NODE_ENV`, which a freshly-built
  // `Record<string, string>` does not satisfy.
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) {
      Reflect.deleteProperty(env, key);
    }
  }

  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';

  return env;
};

export const git = (cwd: string, ...args: readonly string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    // Capture stderr rather than inheriting it: git narrates branch switches and
    // pushes on stderr even when it succeeds, which would otherwise scatter
    // through the suite's output.
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export const commit = (cwd: string, subject: string): string => {
  writeFileSync(path.join(cwd, 'file.txt'), `${subject}\n`);
  git(cwd, 'add', 'file.txt');
  git(cwd, 'commit', '-m', subject);
  return git(cwd, 'rev-parse', 'HEAD');
};

/** Write an executable stub into the fixture's `bin`, shadowing the real tool. */
export const stub = (fixture: Fixture, name: string, script: string): void => {
  const target = path.join(fixture.bin, name);

  writeFileSync(target, script.startsWith('#!') ? script : `#!/bin/sh\n${script}\n`);
  chmodSync(target, 0o755);
};

/**
 * A `pnpm` that records every invocation and can be told to fail one of them.
 *
 * The previous stub was `exit 0` unconditionally, so no gate-failure branch in
 * any hook had ever been driven red — the same "only ever observed passing"
 * condition that let `tsc-files` sit broken for months. `PNPM_FAIL` is a glob
 * matched against the whole argument string, e.g. `run typecheck*`.
 */
const PNPM_STUB = `#!/bin/sh
: "\${PNPM_LOG:=/dev/null}"
printf '%s\\n' "$*" >> "$PNPM_LOG"
case "$*" in
  \${PNPM_FAIL:-__never_matches__})
    printf 'stub: forced failure for %s\\n' "$*" >&2
    exit 1
    ;;
esac
exit 0
`;

/**
 * Builds an isolated local + bare-remote pair with one commit on `main`.
 * The remote starts EMPTY — no refs at all — which is the state a freshly
 * created GitHub repository is in.
 */
export const createFixture = (): Fixture => {
  const root = mkdtempSync(path.join(tmpdir(), 'husky-hook-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const tmp = path.join(root, 'tmp');
  const bin = path.join(root, 'bin');

  mkdirSync(remote);
  mkdirSync(local);
  mkdirSync(tmp);
  mkdirSync(bin);

  const fixture: Fixture = { bin, local, pnpmLog: path.join(tmp, 'pnpm.log'), remote, root, tmp };

  // The hooks shell out to `pnpm run …` / `pnpm exec …` once the git-level
  // checks pass. Those cost minutes and are not what these tests assert on.
  stub(fixture, 'pnpm', PNPM_STUB);

  git(remote, 'init', '--bare', '--initial-branch=main');
  git(local, 'init', '--initial-branch=main');
  git(local, 'config', 'user.email', 'test@example.com');
  git(local, 'config', 'user.name', 'Test');
  git(local, 'remote', 'add', 'origin', remote);
  commit(local, 'chore: initial commit');

  return fixture;
};

/** Build the same pair, but with no commit and therefore no HEAD yet. */
export const createUnbornFixture = (): Fixture => {
  const fixture = createFixture();

  rmSync(fixture.local, { force: true, recursive: true });
  mkdirSync(fixture.local);
  git(fixture.local, 'init', '--initial-branch=main');
  git(fixture.local, 'config', 'user.email', 'test@example.com');
  git(fixture.local, 'config', 'user.name', 'Test');
  git(fixture.local, 'remote', 'add', 'origin', fixture.remote);

  return fixture;
};

export const cleanupFixture = (fixture: Fixture): void => {
  rmSync(fixture.root, { force: true, recursive: true });
};

/** Everything the stubbed `pnpm` was asked to run, one invocation per line. */
export const readPnpmLog = (fixture: Fixture): string =>
  existsSync(fixture.pnpmLog) ? readFileSync(fixture.pnpmLog, 'utf8') : '';

/**
 * Runs a hook and resolves with its exit code, streams, and log.
 *
 * `detached` puts the child in its own session so it has no controlling
 * terminal: `pre-push`'s `/dev/tty` probe then fails, and it neither spawns a
 * live `tail` nor spills its log into the terminal running the suite.
 */
export const runHook = async (fixture: Fixture, options: RunHookOptions): Promise<HookResult> => {
  const { args = [], env = {}, hook, stdin = '' } = options;
  // Annotated rather than inlined: `spawn` picks its return type by overload,
  // and an un-annotated literal collapses to the intersection of every overload
  // — leaving `stdin`/`stdout` typed `never`. `SpawnOptionsWithoutStdio` selects
  // the one whose three streams are non-null.
  const spawnOptions: SpawnOptionsWithoutStdio = {
    cwd: fixture.local,
    detached: true,
    env: {
      // Same reasoning as `git` above: a hook that spawns this suite would
      // otherwise hand the hook under test the OUTER hook's GIT_* variables.
      ...cleanGitEnv(),
      PATH: options.path ?? `${fixture.bin}:${process.env.PATH ?? ''}`,
      PNPM_LOG: fixture.pnpmLog,
      TMPDIR: fixture.tmp,
      ...env,
    },
    stdio: 'pipe',
  };
  const child = spawn('sh', ['-e', path.join(HUSKY_DIR, hook), ...args], spawnOptions);

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(stdin);

  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });

  const logPath = path.join(fixture.tmp, `husky-${hook}.log`);

  return { code, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : null, stderr, stdout };
};

/** git's stdin line for a push that CREATES `ref` on the remote. */
export const createRef = (ref: string, sha: string): string =>
  `refs/heads/${ref} ${sha} refs/heads/${ref} ${ZERO_SHA}\n`;

/** git's stdin line for a push that UPDATES an existing `ref` on the remote. */
export const updateRef = (ref: string, sha: string, remoteSha: string): string =>
  `refs/heads/${ref} ${sha} refs/heads/${ref} ${remoteSha}\n`;
