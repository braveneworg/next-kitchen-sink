# The pre-push hook judged a push by proxies for what it carried

**Date:** 2026-10-10
**Category:** tooling

## What happened

A dependency-only branch — `package.json` and `pnpm-lock.yaml`, with a major
bump of `next` among the changes — was pushed three times. Each time the hook
answered:

```
📦 No .ts or .tsx files changed — skipping type-check, lint, format, and tests.
🚀 Pushing changes...
```

Nothing was run. The gate had to be run by hand to learn whether the bump broke
anything.

After the merge, deleting the merged branch from the `main` checkout failed:

```
$ git push origin --delete chore/fix-dependabot-vulnerabilities
🚫 You are on the 'main' branch. Pushing directly to this branch is not allowed.
```

The push did not touch `main`. It carried no commits at all.

Reading the hook to fix those two turned up a third, in the opposite
direction. From a feature branch, `git push origin feat/thing:main` updated
`main` and the branch check never looked: it asked which branch was checked
out, and a feature branch was.

## Why

All three are the same mistake. git tells a pre-push hook exactly what a push
does — one `<local ref> <local sha> <remote ref> <remote sha>` line per ref —
and the hook answered its questions from something easier to compute instead.

| Question                           | Proxy the hook used        | What it got wrong                        |
| ---------------------------------- | -------------------------- | ---------------------------------------- |
| Could this change break the gate?  | Did a `.ts`/`.tsx` change? | Lockfile, config, Markdown, hooks        |
| Is this a push to `main`?          | Is `main` checked out?     | Refspec pushes; deletions made from main |
| Is there anything to check at all? | (not asked)                | A deletion ran, or was refused, as code  |

The extension test was the most expensive of these because it read like a
considered optimisation. It assumed every file that is not TypeScript is inert,
and in this repository almost none are:

- `pnpm-lock.yaml` and `package.json` decide what the compiler and the tests
  resolve.
- `scripts/coverage-gate.spec.ts` reads the real `COVERAGE_METRICS.md`, and
  the coverage gate parses it.
- `format:check` covers Markdown, JSON and CSS.
- The hook specs execute `.husky/*`.

## The rule

- **The gate runs for every push that carries commits.** There is no
  "nothing relevant changed" shortcut, and a narrower one must not be
  reintroduced. A list of "files no gate reads" is a claim about every test and
  tool in the repository; nothing verifies it and it goes stale silently, in
  the fail-open direction.
- **Protection is decided from the remote ref name on stdin**, in addition to
  the checked-out branch. Either one being `main` is enough to refuse.
- **A push from `main` is still refused even when the refspec names another
  branch.** Everything the hook measures — commits ahead, the WIP scan, the
  gate — is measured on HEAD. Allowing `git push origin feat/x` from `main`
  would gate `main`'s tree and send `feat/x` unexamined.
- **A delete-only push skips the checks, and only after the protected-branch
  refusal.** The exemption exists because there is nothing to check, so it must
  not become a way to delete the branch the checks protect. A push that mixes a
  deletion with an update is an ordinary push.

`scripts/pre-push-hook.spec.ts` pins each of these: the full gate for seven
single-file changes that are not TypeScript-shaped in the way the old test
expected, the refspec push, both directions of the deletion rule, and the
mixed push.

## Generalisation

When a guard is handed the facts, a cheaper stand-in for them is a second
source of truth that will eventually disagree with the first — and it fails in
whichever direction nobody tested. An optimisation that decides _whether a
check runs_ deserves more suspicion than the check itself: when it is wrong,
the output is a reassuring message and no check.

This is the same shape as
[`lint-staged-globs-decide-the-staged-gate.md`](lint-staged-globs-decide-the-staged-gate.md),
one hook later: there the staged gate covered only what a glob listed, here the
push gate covered only what an extension test admitted.
