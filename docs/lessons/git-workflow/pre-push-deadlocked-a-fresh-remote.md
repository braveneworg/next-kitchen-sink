# The pre-push hook deadlocked the very first push to a new remote

**Date:** 2026-08-16
**Category:** git-workflow

## What happened

Pushing this template to a brand-new, empty GitHub repository was impossible.
Every route the hook allowed was closed:

```
$ git push -u origin main
🚫 You are on the 'main' branch. Pushing directly to this branch is not allowed.

$ git checkout -b chore/initial-import && git push -u origin chore/initial-import
fatal: couldn't find remote ref main
❌ Failed to fetch latest changes from origin/main.
```

Two independent checks combined into a deadlock:

- **branch protection** refused any push while `HEAD` was `main` or `master`.
- **fetch `$sync_ref`** refused any push from _any_ branch when `origin/main`
  did not exist, because a first-push branch falls back to comparing against
  `origin/main` and `git fetch origin main` fails on a remote that has no
  `main`.

So `main` could not be pushed, and nothing else could be pushed until `main`
existed. The hook honours no bypass environment variable, and `--no-verify` is
forbidden by `AGENTS.md`. This is not a niche case: it is what **every** user of
this template hits on their first push.

## Why

Both checks were written for the steady state — a shared remote whose `main`
already exists and is worth protecting from direct pushes and stale merges.
Neither had a notion of "the remote does not have this branch yet", so the
absence of a baseline read as a violation rather than as the bootstrap it is.

The `git fetch` failure compounded it: a fetch fails identically for "the branch
is missing" and "the network is down", and the hook treated every failure as the
latter. The existing `upstream_deleted` branch already knew how to tell them
apart with `git ls-remote --exit-code` (exactly `2` means reachable-but-no-such-ref)
— but only for branches with a configured upstream, never for `origin/main`
itself.

## The rule

The bootstrap case is two different questions, and they take different answers.

**"May I push to main?"** — a permission, so the bar is high. The exception
applies only when the remote has **no refs at all**: `git ls-remote <remote>`
answers, and prints nothing. A missing `main` is deliberately not enough. If it
were, deleting `main` on the forge would re-open direct pushes to it forever
after, which is the opposite of what the check exists for.

Getting there needs both signals, and the order is the point:

1. Every ref in the push is being created — git reports an all-zero remote sha
   for each on the hook's stdin. Free, straight from git's own push
   negotiation, and it short-circuits the common case so an ordinary accidental
   push to `main` never pays for a network round trip. But it cannot tell an
   unseeded repository from a deleted branch, so on its own it proves nothing.
2. The remote itself is empty. Costs a round trip, so it runs only after (1)
   has already narrowed things down.

A remote that cannot be **reached** must never read as one that is empty —
otherwise a network blip unlocks `main`. `remote_ref_state()` returns a distinct
code for unreachable and the hook fails on it. Likewise, when stdin carries no
ref lines (the hook run by hand) nothing can be told apart, so the strict path
stands.

**"What do I compare against?"** — not a permission, so a missing `$sync_ref` is
simply the absence of an answer, whether or not the remote holds other refs. It
sets `no_baseline=1`, which skips the up-to-date check and runs the full gate in
place of the "no `.ts`/`.tsx` changed" shortcut — that shortcut would otherwise
wave every file through, since there is nothing to diff against.

`scripts/pre-push-hook.spec.ts` pins all of this against real bare repositories.
The tests that matter most are the negative ones: an existing remote `main` is
still protected, a `main` deleted from a remote that still has refs does not
re-open the exception, and an unreachable remote fails rather than passing for
an unseeded one.

## Generalisation

Any check that compares against a remote baseline needs an answer for "the
baseline does not exist yet", and it is almost never "fail". Bootstrap is a
legitimate state, not an anomaly — and a guard with no bootstrap path turns into
a lock with the key inside. When a guard makes its own repository unusable, the
guard is wrong; reaching for `--no-verify` only hides that.
