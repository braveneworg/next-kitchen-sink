# Shell helpers answer in tokens, not exit codes

**Date:** 2026-08-29
**Category:** tooling

## What happened

`.husky/pre-push` carried two inline helpers, 80 lines apart, that solved the
same problem: git conflates "this ref does not exist" with "I could not reach
the remote". They resolved it with **contradictory numeric conventions**.

```sh
# remote_ref_state: 0 = no refs at all, 1 = has refs, 2 = unreachable
# fetch_sync_ref:   0 = fetched,        1 = network failure, 2 = no such ref
```

`1` and `2` mean opposite things in two functions in one file. Nothing caught
it, because a number carries no meaning at the call site — `case $? in 2)` reads
identically whichever convention is in force.

## Why it happened

The two were written at different times to answer questions that felt local, so
neither call site had any reason to look at the other. Numeric exit codes make
that drift invisible: the compiler cannot check them, the reader cannot see
them, and a transposition produces working-looking code that takes the wrong
branch only in the rare state it was written for.

They are also hostile to `set -e`. A helper that returns 1 to mean something
ordinary aborts any caller that invokes it outside a condition context, so every
caller ends up wrapped defensively.

## The rule

A shell helper with more than two outcomes prints a **named token** on stdout
and always returns 0.

```sh
remote_state() {           # empty | populated | unreachable
  hk_refs=$(git ls-remote "$1" 2>/dev/null) || { printf 'unreachable\n'; return 0; }
  if [ -z "$hk_refs" ]; then printf 'empty\n'; else printf 'populated\n'; fi
  return 0
}

case "$(remote_state "$push_remote")" in
  empty)     seeding_allowed=1 ;;
  populated) : ;;
  *)         fail "Could not reach '$push_remote'." ;;   # strict arm
esac
```

`empty` and `unreachable` cannot be transposed the way `0` and `2` can. The
function is `set -e`-proof because it always succeeds. And the `*)` arm must be
the strict one, so a token added later fails closed instead of silently reading
as success.

Two mechanics this depends on, both verified rather than assumed:

- **Any captured helper must send its children's stdout to stderr.**
  `state=$(fetch_branch …)` splices anything `git fetch` prints into the token.
  `git fetch "$1" "$2" --quiet >&2` — `--quiet` alone is not enough.
- **`printf`, never `echo`.** macOS `/bin/sh` expands backslash escapes in
  `echo`, so a branch name or commit subject containing one renders differently
  there than on Linux CI.

## Generalisation

Two functions that answer the same underlying question belong next to each
other, under one documented vocabulary. Distance is what let these drift — they
now live together in `.husky/lib.sh`, sharing the literal string `unreachable`,
which is the thing
[`pre-push-deadlocked-a-fresh-remote.md`](../git-workflow/pre-push-deadlocked-a-fresh-remote.md)
insists must never be conflated with "absent".

Related trap, found while extracting them: **`. lib.sh || exit 1` does not
work.** `.` is a POSIX special builtin, so a non-interactive shell exits on a
read failure _before_ the `||` is evaluated. Guard first:

```sh
[ -r "$hook_lib" ] || { printf '%s\n' "husky: $hook_lib missing" >&2; exit 1; }
. "$hook_lib"
```
