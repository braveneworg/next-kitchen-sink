import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * `pnpm-lock.yaml` must stay a single YAML document.
 *
 * pnpm 12 records the package manager it resolved for a project in a second
 * document that it writes FIRST — an "env lockfile" holding only pnpm and its
 * platform binaries. Both documents declare `lockfileVersion: '9.0'`, so a
 * reader built for one document gets no signal that anything changed. It reads
 * the first, finds pnpm, and concludes the project has no dependencies.
 *
 * GitHub's dependency graph is such a reader. With the env document present it
 * listed 16 packages for this repository — pnpm, its 14 binaries and the repo
 * itself — out of more than 800, and Dependabot alerts are computed from that
 * graph. Nothing fails when this happens: the graph is simply, quietly empty.
 *
 * `pmOnFail: ignore` in `pnpm-workspace.yaml` is what keeps the env document
 * from being written. This spec fails if that setting is dropped and the
 * lockfile regenerated.
 * See docs/lessons/tooling/pnpm-12-env-lockfile-blinds-dependabot.md.
 */
const LOCKFILE = path.join(import.meta.dirname, '..', 'pnpm-lock.yaml');

/** A `---` on a line of its own, which is how YAML separates documents. */
const DOCUMENT_MARKER = /^---$/gm;

describe('pnpm-lock.yaml', () => {
  it('is a single YAML document', () => {
    expect(readFileSync(LOCKFILE, 'utf8').match(DOCUMENT_MARKER) ?? []).toEqual([]);
  });

  // The marker test alone would pass on a file holding only the env document,
  // should pnpm ever write that one without a leading separator.
  it('records the project dependencies, not just the package manager', () => {
    const lockfile = readFileSync(LOCKFILE, 'utf8');

    expect({
      dependencies: /^ {4}dependencies:$/m.test(lockfile),
      packageManager: /^ {4}packageManagerDependencies:$/m.test(lockfile),
    }).toEqual({ dependencies: true, packageManager: false });
  });
});
