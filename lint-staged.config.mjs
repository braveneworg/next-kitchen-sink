/**
 * lint-staged appends the matched staged filenames to every command it runs.
 * For `tsc` that is actively harmful: passing input files on the CLI makes
 * TypeScript ignore `tsconfig.json` entirely and compile with default options,
 * so the check passes on code the real build rejects. A function entry is
 * lint-staged's documented way to run a command with no filename arguments —
 * see "Run `tsc` on changes to TypeScript files, but do not pass any filename
 * arguments" in its README.
 *
 * The command is `pnpm run typecheck` rather than a bare `tsc --noEmit` so the
 * hook and the documented gate can never drift, and because `typecheck` runs
 * `next typegen` first: `PageProps` and `LayoutProps` are generated globals
 * that `layout.tsx` and `page.tsx` reference, so without typegen the hook fails
 * on any clone that has not yet run a dev server or build.
 *
 * This replaced `tsc-files`, which resolved the compiler at a `.bin` directory
 * sibling to the `typescript` package — a path that does not exist under pnpm's
 * isolated store. The spawn failed with ENOENT, `status` came back `null`, and
 * `process.exit(null)` exited 0, so the staged type check silently passed on
 * everything. See docs/lessons/tooling/tsc-files-silently-passes-under-pnpm.md.
 *
 * @type {import('lint-staged').Configuration}
 */
export default {
  'src/**/*.{ts,tsx}': [() => 'pnpm run typecheck', 'oxlint --fix --max-warnings 0', 'prettier --write'],
  '*.{json,css,md}': ['prettier --write'],
};
