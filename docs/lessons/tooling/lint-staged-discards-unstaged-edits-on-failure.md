# Running `lint-staged` by hand can discard edits to partially staged files

**Date:** 2026-08-16
**Category:** tooling

## What happened

While replacing `tsc-files`, the new `lint-staged.config.mjs` was tested by
running the tool directly:

```bash
pnpm exec lint-staged
```

At that moment `package.json` was **partially staged**: the staged copy still
contained the old `lint-staged` block and the `tsc-files` devDependency, while
the working tree had both removed. The run was _expected_ to fail — a deliberate
type error had been staged to prove the new gate catches errors. It failed
correctly, and printed:

```
✖ Failed to run tasks for staged files!
⋯ Staging changes from tasks…
✔ Done staging changes from tasks!
↓ Skipped restoring unstaged changes…
```

That last line is the damage. The working-tree edits to `package.json` were
gone; the file was back to the staged version, `lint-staged` block and
`tsc-files` and all. `pnpm remove tsc-files` had to be re-run and the edit
redone.

## Why

`lint-staged` runs with `hide-partially-staged: true` by default: for any file
that is staged _and_ further modified, it hides the unstaged portion so tasks
see exactly what is about to be committed. The hidden work lives in a backup
stash — its own README carries a `> [!CAUTION]` about this — and on the failure
path it prints `↓ Skipped restoring unstaged changes…` rather than putting it
back, to avoid clobbering whatever the failing task may have written.

The trigger is _partial staging_, not unstaged work in general. A file that is
purely unstaged and untouched by any matching glob is left alone. A file that is
both staged and dirty is the dangerous case — and during a large initial commit,
where everything is staged, almost every edit creates one.

This only bites when invoking `lint-staged` manually. In its intended context —
a `pre-commit` hook — the tree is staged by definition.

## Recovery

The backup stash is real but short-lived: a later successful run drops it. Look
before doing anything else. lint-staged's own `--help` documents the path:

```bash
git stash list --format="%h %s"     # <hash> On <branch>: lint-staged automatic backup
git apply --index <hash>
```

## The rule

Stage everything **before** running `pnpm exec lint-staged` by hand, so no file
is partially staged and nothing is left to lose:

```bash
git add -A                    # no partially staged files remain
printf 'export const broken: number = %s;\n' "'nope'" > src/lib/__probe.ts
git add src/lib/__probe.ts
pnpm exec lint-staged         # expect non-zero
git rm --cached -q src/lib/__probe.ts && rm src/lib/__probe.ts
```

## Generalisation

Tools that manipulate the git index or stash on your behalf — `lint-staged`,
rebase helpers, codemod runners — treat the unstaged half of a partially staged
file as scratch space they may hide, and may decline to un-hide it on the error
path. That half is the least durable state in a repo. Before invoking one of
these manually, get to a state where losing the working tree costs nothing.
