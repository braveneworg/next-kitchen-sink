# lint-staged's globs decide what the staged gate actually covers

**Date:** 2026-08-29
**Category:** tooling

## What happened

`lint-staged.config.mjs` had two entries:

```js
'src/**/*.{ts,tsx}': [() => 'pnpm run typecheck', 'oxlint --fix --max-warnings 0', 'prettier --write'],
'*.{json,css,md}': ['prettier --write'],
```

Nothing matched `scripts/**`. A run of commits touching only repo tooling
produced:

```
🔍 Running lint-staged...
→ lint-staged could not find any staged files matching configured tasks.
✅ Linting staged files passed
✅ Type check of staged files passed
```

No oxlint, no Prettier, no type check — and two banners saying otherwise. The
same hole covered `vitest.config.ts`, `setupTests.ts`, `lint-staged.config.mjs`
itself, and every hook in `.husky/`.

## Why it happened

The config was written when `src/` was the only code that existed, and repo
tooling grew afterwards without anyone revisiting it. `pnpm run lint` covers
`scripts/**` — `.oxlintrc.json` has an explicit override for `scripts/**/*.ts` —
so the code _was_ linted by the full gate. Only the staged gate skipped it, and
the hook reported success either way, so nothing surfaced the gap.

The banners are the reason it stayed hidden. They were printed unconditionally
after `pnpm exec lint-staged` returned 0, and lint-staged exits 0 when it
matches nothing. "Passed" and "did not run" were indistinguishable.

## The rule

Two rules, and the second matters more.

1. **When you add a directory of code, add it to `lint-staged.config.mjs`.** The
   staged gate's coverage is exactly its glob list — there is no fallback.

   ```js
   '{scripts,types}/**/*.ts': ['oxlint --fix --max-warnings 0', 'prettier --write'],
   ```

   Do not add a second `pnpm run typecheck` entry: the existing one is
   project-wide, so it already checks these files whenever it fires at all.

2. **Never print a success banner a command did not earn.** Let the runner that
   ran the command report it — `run_gate` in `.husky/lib.sh` prints
   `✅ <label> passed` only on the success path of the command it just ran, and
   there is no way to print it without running something.

## Generalisation

This is the same shape as
[`tsc-files-silently-passes-under-pnpm.md`](tsc-files-silently-passes-under-pnpm.md)
and [`piping-gate-commands-hides-failures.md`](piping-gate-commands-hides-failures.md):
a gate that exits 0 without doing its job, wearing a message that says it did.
When a check is cheap to fake, assert that it _ran_, not merely that it passed —
the hook specs now check the recorded `pnpm` invocations, not the exit code
alone.
