# `tsc-files` silently passes under pnpm — the staged type check is a no-op

**Date:** 2026-08-16
**Category:** tooling

## What happened

`package.json`'s lint-staged block type-checks staged sources with:

```json
"src/**/*.{ts,tsx}": ["tsc-files --noEmit types/vitest.d.ts", "oxlint --fix --max-warnings 0", "prettier --write"]
```

`types/vitest.d.ts` did not exist in the repo. The expectation was that
lint-staged would fail on the first commit touching `src/**/*.{ts,tsx}`.

It does not fail. It passes — and so does everything else. A file containing
`export const broken: number = 'not a number';` passes the staged check:

```bash
$ pnpm exec tsc-files --noEmit types/vitest.d.ts src/lib/__probe.ts
$ echo $?
0
$ pnpm exec tsc --noEmit          # same file, whole project
src/lib/__probe.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

The staged type check has never checked anything.

## Why

`tsc-files@1.1.4` (`cli.js:76-88`) locates the compiler by walking up from the
resolved `typescript` package to a **sibling** `.bin` directory:

```js
resolveFromModule('typescript', `../.bin/tsc${process.platform === 'win32' ? '.cmd' : ''}`);
```

That layout is npm/yarn's flat `node_modules`. Under pnpm's isolated store the
package lives at `node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/`
and there is no sibling `.bin/`:

```bash
$ ls node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/../.bin/
ls: No such file or directory
```

`spawnSync` on a non-existent binary does not throw — it returns
`{ status: null, error: ENOENT }`. `cli.js` ends with `process.exit(status)`,
and `process.exit(null)` exits **0**. The compiler is never spawned, the ENOENT
is never surfaced, and the hook reports success.

This is a pnpm-layout bug, not a TypeScript 7 bug. The real binary is at
`<typescript>/bin/tsc` (and at `node_modules/.bin/tsc`); `tsc-files` looks in
neither.

## The rule

Do not trust a quality gate until you have watched it **fail** on a known-bad
input. Add a deliberate error, confirm non-zero exit, then remove it. A gate
that has only ever been observed passing is indistinguishable from a gate that
cannot fail.

## How it was fixed

`tsc-files` was removed. lint-staged's config moved out of `package.json` into
`lint-staged.config.mjs`, because the replacement has to be a **function** entry
and JSON cannot express one:

```js
export default {
  'src/**/*.{ts,tsx}': [() => 'pnpm run typecheck', 'oxlint --fix --max-warnings 0', 'prettier --write'],
  '*.{json,css,md}': ['prettier --write'],
};
```

The function form is required, not stylistic. lint-staged appends the matched
staged filenames to every **string** command, and passing input files to `tsc`
on the CLI makes it **ignore `tsconfig.json` entirely** and compile with default
options — a second, quieter way to get a meaningless pass. This is documented in
lint-staged's own README ("Run `tsc` on changes to TypeScript files, but do not
pass any filename arguments", and again in its FAQ).

The command is `pnpm run typecheck`, not a bare `tsc -p tsconfig.json --noEmit`:
it keeps the hook and the documented gate from drifting, and it runs
`next typegen` first, so a clone that has never started a dev server still has
the `PageProps` / `LayoutProps` globals `layout.tsx` needs. Whole-project
`tsc --noEmit` is ~0.46s here and `pnpm run typecheck` ~0.92s — both faster than
`tsc-files`' temp-config dance, and stricter, since they also catch breakage in
files that _depend_ on the changed file.

Verified red before green: with `export const broken: number = 'not a number'`
staged, `pnpm exec lint-staged` now exits 1 and prints the real `TS2322`. With a
clean tree it exits 0.

## Generalisation

`spawnSync` returning `status: null` is the shape to watch for. Any wrapper that
forwards a child's status without checking `result.error` first will convert
"could not run the tool" into "the tool approved your code."
