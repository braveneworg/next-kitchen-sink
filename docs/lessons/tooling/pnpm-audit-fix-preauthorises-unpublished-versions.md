# `pnpm audit --fix` pre-authorises versions that do not exist

**Date:** 2026-10-10
**Category:** tooling

## What happened

A vulnerability sweep started from Dependabot, which reported zero open alerts.
`pnpm audit` on the same lockfile reported 59 advisories, four of them critical.
Both read the GitHub Advisory Database; the difference was that the
repository's dependency graph was not populated (`GET
/repos/{owner}/{repo}/dependency-graph/sbom` answered 404), so Dependabot had
nothing to match advisories against.

`pnpm update` cleared all but four findings, in two packages. Running
`pnpm audit --fix update` to finish the job fixed none of them and edited
`pnpm-workspace.yaml` anyway:

```
0 vulnerabilities were fixed, 4 vulnerabilities remain.

1 entries were added to minimumReleaseAgeExclude to allow installing the patched versions:
braces@3.0.4
```

```yaml
minimumReleaseAgeExclude:
  - braces@3.0.4
```

`braces@3.0.4` has never been published. The advisory (`GHSA-vfj7-8cjw-p6xm`)
has no patched version at all — its `firstPatchedVersion` is `null` — and
`pnpm audit` synthesises `>=3.0.4` as the "patched" range from the vulnerable
range `<=3.0.3`.

The other package, `brace-expansion`, did have a fix (5.0.12, inside
`minimatch`'s `^5.0.8` range), but neither `pnpm update --depth 99
brace-expansion` nor `pnpm audit --fix update` would move the lockfile off
5.0.9. Both answered `Already up to date`. The cause was not established.

## Why it matters

`minimumReleaseAge` exists to keep a freshly published — possibly hijacked —
release out of the tree until it has had time to be noticed. An exclusion for a
version number that is still unclaimed waives that cool-down in advance for
whatever is eventually published under it. "A security fix for a known
advisory" is exactly the cover a compromised maintainer account would use.
Committing that line would have looked like part of the remediation.

## The rule

- An empty Dependabot alert list is not evidence of a clean tree. Cross-check
  with `pnpm audit`, and if the two disagree, check that the dependency graph
  is populated before trusting either.
- Diff `pnpm-workspace.yaml` after every `pnpm audit --fix` run, including runs
  that report nothing fixed. Revert any `minimumReleaseAgeExclude` entry whose
  version `pnpm view <pkg> versions` does not list.
- Before treating a finding as fixable, confirm the patched version exists.
  The advisory's own `firstPatchedVersion` is the authority, not the range
  `pnpm audit` prints.
- When `pnpm update` will not move an in-range transitive dependency, move it
  with a temporary override and then remove the override:

  ```bash
  # 1. add to pnpm-workspace.yaml
  #    overrides:
  #      'brace-expansion@>=5.0.0 <5.0.12': ^5.0.12
  pnpm install
  # 2. remove the override again
  pnpm install                    # lockfile keeps 5.0.12: it satisfies ^5.0.8
  pnpm install --frozen-lockfile  # proves the lockfile stands on its own
  ```

  The lockfile ends where `pnpm update` should have left it, and no override
  is left behind to pin the package after the parent catches up.

## Generalisation

A "fix" command that reports failure may still have written configuration.
Read the diff of what a remediation tool changed, not just its summary line —
and be most suspicious of changes that loosen a guard in order to let the fix
through.
