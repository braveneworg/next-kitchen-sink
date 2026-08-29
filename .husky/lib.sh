#!/bin/sh
# Shared helpers for the husky hooks. Sourced, never executed — git only ever
# runs <hooksPath>/<hookname>, and husky's installer writes stubs for a fixed
# list of hook names, so this file is invisible to both.
#
# Source it with the three-line guard the hooks use:
#
#   hook_lib="$(dirname "$0")/lib.sh"
#   [ -r "$hook_lib" ] || { printf '%s\n' "husky: $hook_lib missing" >&2; exit 1; }
#   . "$hook_lib"
#
# The `[ -r ]` test has to come FIRST. `.` is a POSIX special builtin, so a
# non-interactive shell exits immediately when it cannot read its argument —
# before any `||` on the same line is consulted. `. lib.sh || exit 1` therefore
# does not do what it looks like it does.
#
# Rules this file follows, because it is sourced into three different option
# regimes (pre-commit `set -e`, pre-push `set +e`, commit-msg neither):
#
#   1. It sets nothing. No `set`, no `trap`, no `exec`, no `cd`. Sourcing it is
#      unobservable except for the names it defines, which is what makes its
#      position relative to pre-push's fd juggling irrelevant.
#   2. Every function ends in an explicit `return 0` or `exit`. Falling off the
#      end returns the last command's status, which under `set -e` aborts a
#      caller for reasons invisible at the call site.
#   3. Only `is_protected_branch` may return non-zero, and only from a condition
#      context (`if`, `if !`, `&&`, `||`).
#   4. Multi-outcome answers are STRINGS on stdout, never numeric exit codes.
#      `remote_ref_state` and `fetch_sync_ref` used to disagree about whether 1
#      meant "no such ref" or "unreachable"; `empty` and `unreachable` cannot be
#      transposed the way 0/1/2 can.
#   5. Any function whose output is captured sends its children's stdout to
#      stderr, or `$( )` would splice git's chatter into the token.
#   6. `printf`, never `echo`. macOS /bin/sh expands backslash escapes in echo,
#      so a branch name or commit subject containing one would render
#      differently here than on Linux CI.
#   7. Variables are `hk_`-prefixed globals rather than `local`, which is not in
#      POSIX; the prefix keeps them from colliding with hook-level names.

# Prints the current branch, empty on an unborn branch, "HEAD" when detached.
# Always exits 0.
#
# `--show-current` first: `rev-parse --abbrev-ref HEAD` exits 128 before the
# first commit exists, which under `set -e` killed pre-commit and made the very
# first commit of a repository impossible. rev-parse survives only as a fallback
# for the detached-HEAD case, where `--show-current` prints nothing but callers
# want the string "HEAD".
current_branch() {
  hk_branch=$(git branch --show-current 2>/dev/null) || hk_branch=""

  if [ -z "$hk_branch" ]; then
    hk_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || hk_branch=""
  fi

  printf '%s\n' "$hk_branch"
  return 0
}

# 0 when the named branch is one that commits and pushes are kept off, 1
# otherwise. Silent, and the single definition of that policy — it used to be
# spelled out separately in pre-commit and pre-push. Call only from a condition
# context; a bare call would abort a `set -e` hook on the common case.
is_protected_branch() {
  case "$1" in
    main | master) return 0 ;;
    *) return 1 ;;
  esac
}

# Narration. `info` goes to stdout; everything else to stderr. Arguments after
# the first print as indented continuation lines.
info() {
  printf 'ℹ️  %s\n' "$1"
  shift
  for hk_line in "$@"; do
    printf '   %s\n' "$hk_line"
  done
  return 0
}

warn() {
  printf '⚠️  %s\n' "$1" >&2
  shift
  for hk_line in "$@"; do
    printf '   %s\n' "$hk_line" >&2
  done
  return 0
}

# A refusal (🚫) is "you may not do this"; a failure (❌) is "a check did not
# pass". Both EXIT rather than returning, because every bad outcome this repo
# has recorded — tsc-files exiting 0, a piped gate hiding its status, pre-push's
# dropped flags — is the same shape: something reported a problem and then did
# not stop anything. Call only from the main shell, never inside `$( )` or a
# pipeline, where `exit` would leave the hook running.
refuse() {
  printf '🚫 %s\n' "$1" >&2
  shift
  for hk_line in "$@"; do
    printf '   %s\n' "$hk_line" >&2
  done
  exit 1
}

fail() {
  printf '\n' >&2
  printf '❌ %s\n' "$1" >&2
  shift
  for hk_line in "$@"; do
    printf '   %s\n' "$hk_line" >&2
  done
  exit 1
}

# run_gate <label> <remedy> <command> [args...]
#
# Announces, runs, and either confirms or fails the hook. The command is passed
# as real argv and run directly — never re-split, never appended to, never
# piped. That is deliberate: `pnpm run x --flag` silently appended the flag to
# the END of the script string, and a pipeline would replace the gate's exit
# status with the last stage's. An empty <remedy> reuses the command itself.
run_gate() {
  hk_label="$1"
  hk_remedy="$2"
  shift 2

  printf '🔍 Running %s...\n' "$hk_label"

  if "$@"; then
    printf '✅ %s passed\n' "$hk_label"
    return 0
  fi

  if [ -z "$hk_remedy" ]; then
    hk_remedy="$*"
  fi

  fail "$hk_label failed." "Run '$hk_remedy' to see the details."
}

# Prints what <remote> holds: empty | populated | unreachable. Always exits 0.
#
# `git ls-remote` prints one line per ref, so empty output with a zero status is
# an unseeded repository — and only that. A reachability failure gets its own
# token rather than being folded in as "looks empty", because that would turn a
# network blip into an unlocked main.
remote_state() {
  hk_refs=$(git ls-remote "$1" 2>/dev/null) || {
    printf 'unreachable\n'
    return 0
  }

  if [ -z "$hk_refs" ]; then
    printf 'empty\n'
  else
    printf 'populated\n'
  fi

  return 0
}

# Fetches <remote> <branch>. Prints fetched | absent | unreachable, always
# exits 0.
#
# A bare `git fetch` cannot separate "no such branch" from a network or auth
# failure, so ls-remote arbitrates: its --exit-code returns exactly 2 for
# "reachable, no matching ref". Note `unreachable` is the broader token — it
# also covers "the ref exists but the fetch failed anyway" (shallow clones,
# fetch-only auth), which callers treat the same way.
fetch_branch() {
  # >&2 is mandatory, not tidiness: this function's stdout IS its return value,
  # so anything git prints there would be spliced into the token. stderr is
  # left alone — the hook's log wants git's diagnosis of a failed fetch.
  if git fetch "$1" "$2" --quiet >&2; then
    printf 'fetched\n'
    return 0
  fi

  git ls-remote --exit-code "$1" "refs/heads/$2" >/dev/null 2>&1
  if [ "$?" -eq 2 ]; then
    printf 'absent\n'
  else
    printf 'unreachable\n'
  fi

  return 0
}
