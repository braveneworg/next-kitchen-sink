# `engines.node` pinned nothing — pnpm does not enforce it

**Date:** 2026-10-10
**Category:** tooling

## What happened

The README's requirements table said of Node: "Pinned in `.nvmrc` and enforced
by `engines`." While replacing `.nvmrc` with `mise.toml`, the same claim was
about to be carried over, and `mise.toml`'s own comment described
`engines.node` as "pnpm's engine check".

Testing it took one command. With `engines.node` raised to `^24.21.0` and Node
24.18.0 selected:

```
$ pnpm install --frozen-lockfile     # exit 0, no warning
$ pnpm exec node --version           # v24.18.0
```

pnpm 12.10.1 installed and ran scripts on a Node below the declared floor
without a word. The sentence in the README had never been true.

## Why

pnpm checks the project's own `engines.node` only when `engineStrict` is set.
With `engineStrict: true` in `pnpm-workspace.yaml` the same install fails with
`ERR_PNPM_UNSUPPORTED_ENGINE`; without it the field is metadata.

Nothing else was enforcing the version either. `.nvmrc` is read by nvm when
someone runs `nvm use`, and by nothing at all on a machine that uses another
version manager — mise ignores it unless idiomatic version files are switched
on. So hooks and gate runs on a mise-managed machine used Node 24.21.0 while
the repository declared 24.18.0, and every tool involved was satisfied.

## The rule

- `mise.toml` is the pin. It is the only file a tool on the documented setup
  actually acts on, for both Node and pnpm.
- `engines.node` and `packageManager` mirror it for the tools that read those
  fields — deployment platforms and corepack. `scripts/toolchain-pins.spec.ts`
  fails when the three disagree, and when a `.nvmrc` reappears.
- Do not describe `engines.node` as enforcement. `engineStrict` is deliberately
  left off: it also fails the install for any dependency whose own `engines`
  excludes the running Node, and on a deployment platform the Node patch
  version is the platform's choice, not this file's.
- Before writing that a file "pins" or "enforces" a version, run the tool on
  the wrong version and watch what happens.

## Generalisation

A version file states an intention; only a tool that reads it and refuses to
continue makes it a constraint. Documentation tends to describe the intention
as though it were the constraint, and that gap is invisible for as long as
everyone happens to be on a compatible version.
