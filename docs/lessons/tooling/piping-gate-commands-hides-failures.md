# Piping gate commands through `tail` hides their exit code

**Date:** 2026-08-16
**Category:** tooling

## What happened

While clearing lint findings, the four-command gate was run as a single chain
with each step piped for readability:

```bash
pnpm run typecheck && pnpm run test:run 2>&1 | tail -8 \
  && pnpm run lint && pnpm run format:check 2>&1 | tail -5 \
  && echo "=== ALL FOUR GATES PASSED ==="
```

`format:check` **failed** — `.oxlintrc.json` was unformatted, and Prettier
exited non-zero with `[ELIFECYCLE] Command failed with exit code 1`. The
success banner printed anyway.

## Why

In POSIX shells the exit status of a pipeline is the status of its **last**
command. `pnpm run format:check | tail -5` reports `tail`'s status, and `tail`
essentially always succeeds. The `&&` chain therefore saw success and ran the
`echo`. The real failure was visible in the scrollback but the banner
contradicted it — exactly the shape that produces a false "work is complete"
claim.

## The rule

Never let a verification command's status pass through a pipe. Either drop the
pipe, or check each command separately and report per-step:

```bash
set -e
pnpm run typecheck    >/dev/null 2>&1 && echo "typecheck: PASS" || { echo "typecheck: FAIL"; exit 1; }
pnpm run test:run     >/dev/null 2>&1 && echo "test:run:  PASS" || { echo "test:run: FAIL";  exit 1; }
pnpm run lint         >/dev/null 2>&1 && echo "lint:      PASS" || { echo "lint: FAIL";      exit 1; }
pnpm run format:check >/dev/null 2>&1 && echo "format:    PASS" || { echo "format: FAIL";    exit 1; }
```

If output really must be trimmed, set `pipefail` first (`set -o pipefail`) so
the pipeline adopts the first non-zero status instead of `tail`'s.

## Generalisation

A banner that is printed by the same `&&` chain it is meant to certify is only
as trustworthy as the weakest link's status propagation. Prefer asserting on
each command's own exit code over one composite claim at the end.
