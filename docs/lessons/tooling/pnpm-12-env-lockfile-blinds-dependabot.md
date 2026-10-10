# pnpm 12's lockfile hid every dependency from Dependabot

**Date:** 2026-10-10
**Category:** tooling

## What happened

The `packageManager` pin was moved from pnpm 11.22.0 to 12.10.1. The lockfile
gained 158 lines at the top and lost none, and the commit message recorded that
as the whole of the change: "no dependency moved".

That was true and missed the point. The 158 lines were a second YAML document,
written **first**:

```yaml
---
lockfileVersion: '9.0'

importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.10.1
        version: 12.10.1
# … pnpm's own platform binaries …
---
lockfileVersion: '9.0'
# … the real lockfile …
```

Later the same day the repository's dependency graph was switched on so that
Dependabot could see the project. It reported 16 packages: `pnpm`, fourteen
`@pnpm/exe.*` binaries, and the repository itself. More than 800 real
dependencies were absent, with `parseable: true` and no error anywhere.

## Why

pnpm 12 records the package manager version it resolved, in an "env lockfile"
document that precedes the main one. Both documents declare
`lockfileVersion: '9.0'`, so a consumer written for lockfile v9 has no signal
that the file's shape changed. It reads the first document, finds a perfectly
valid lockfile for a project whose only dependency is pnpm, and stops.

GitHub's dependency graph does exactly that, and Dependabot alerts are computed
from the graph. This is upstream issue
[pnpm/pnpm#13805](https://github.com/pnpm/pnpm/issues/13805), closed as
intended behaviour: the reporter there watched 35 open alerts close as "fixed"
six seconds after a pnpm 12 bump merged, with no dependency changed.

`pnpm audit` is unaffected, which is why nothing looked wrong locally — the
tool that was run agreed with itself.

## The rule

- `pmOnFail: ignore` stays in `pnpm-workspace.yaml`. It is the documented switch
  that stops pnpm writing the env document. The price is that pnpm no longer
  downloads or enforces the pinned version itself; corepack still does, and
  with mise, asdf or Volta that tool decides.
- Setting it does **not** clean an existing lockfile. `pnpm install`,
  `--lockfile-only` and `--fix-lockfile` all left the env document in place
  (and `--fix-lockfile` re-resolved unrelated packages while it was there). The
  document has to be deleted by hand — everything up to and including the
  second `---` — and the result checked with `pnpm install --frozen-lockfile`.
- `scripts/lockfile-shape.spec.ts` fails if the lockfile ever holds more than
  one document.
- After any change to the package manager or lockfile format, check what
  GitHub ingested, not only what pnpm reports:

  ```bash
  gh api repos/<owner>/<repo>/dependency-graph/sbom --jq '.sbom.packages | length'
  ```

  A count in the tens for a project with hundreds of dependencies is this bug.

## Generalisation

A lockfile is an interface, and the package manager is not its only reader.
"The diff only adds lines" describes the change to the file; it says nothing
about whether the file's other consumers can still read it. When a tool
upgrade alters a format that scanners, bots or CI parse, the upgrade is not
verified until one of those readers has been checked — and a reader that
returns a short, well-formed answer instead of an error is the failure worth
looking for.
