# TypeScript 7 removed the JS compiler API — the whole ESLint stack breaks

**Date:** 2026-08-16
**Category:** tooling

## What happened

`pnpm peers check` reported one unmet peer: `typescript@7.0.2` against
`typescript-eslint`'s `>=4.8.4 <6.1.0`. The tempting read is "stale metadata,
suppress it with `peerDependencyRules.allowedVersions`." That read is wrong,
and suppressing it would have hidden a fatal break.

## The actual constraint

`typescript@7` is the Go port (tsgo). It no longer ships the JavaScript
compiler API:

```jsonc
// node_modules/typescript/package.json
"exports": { ".": "./lib/version.cjs", "./unstable/ast": "...", ... }
```

```js
await import('typescript'); // → { version, versionMajorMinor }  — that's all
```

`tsc --noEmit` still works (the `bin/tsc` shim runs the Go binary), so the
breakage is invisible until something imports the API. typescript-eslint does:

```
@typescript-eslint/typescript-estree.parse('const x: number = 1;')
→ TypeError: Cannot read properties of undefined (reading 'Cjs')
```

8.67.0 also ships an explicit guard:

```
Error: typescript-eslint does not support TS 7.0.
  → https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0
  → https://github.com/typescript-eslint/typescript-eslint/issues/10940
```

## Why the obvious escape hatches don't work

- **`peerDependencyRules.allowedVersions`** — silences the warning, leaves
  `pnpm run lint` hard-crashing on the first `.ts` file.
- **Upgrading typescript-eslint** — no published version accepts TS 7,
  canary (`8.67.1-alpha.4`) included. There is nothing to upgrade _to_.
- **`pnpm.overrides` on the peer edge** (`typescript-eslint>typescript`) —
  rewrites the declared _range_ but pnpm still resolves the peer from the
  root, so it neither silences nor injects anything.
- **Dropping `typescript-eslint` alone** — does nothing. `@typescript-eslint/*`
  is a transitive dep of `@vitest/eslint-plugin`,
  `eslint-plugin-unused-imports`, `eslint-plugin-import-x`,
  `eslint-import-resolver-typescript`, and
  `eslint-plugin-prefer-arrow-functions`. All five must go too.

The only ways out are: pin `typescript` to `^6.0.3` (last JS-API line),
isolate the lint toolchain in a workspace package pinned to TS 6, or leave
ESLint entirely.

## What we did

Migrated to **oxlint** (`.oxlintrc.json`). oxc parses TypeScript natively in
Rust, so oxlint has **no `typescript` peer at all** — TS 7 stays. This removed
166 packages and cleared every peer warning.

## How to apply

- Never silence a peer warning without loading the dependency and calling the
  API the consumer actually uses. `pnpm peers check` reports metadata; it does
  not prove the code runs.
- Before assuming a version cap is stale, check whether the upstream published
  a _newer_ release with the same cap. A cap that survives into canary is a
  statement of fact, not neglect.
- When removing a package to clear a peer, run `pnpm why <transitive-pkg>`
  first — the direct dependency is rarely the only path into the tree.

## Related

- `AGENTS.md` → Stack (records oxlint-not-ESLint and the reason)
- `src/AGENTS.md` → scope rules in `.oxlintrc.json`, not `eslint.config.mjs`
