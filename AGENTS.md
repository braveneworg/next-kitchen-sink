# Agent & Contributor Guidelines

Last updated: 2026-08-16

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

Single source of truth for how to work in this repository — for humans and for
every AI coding agent. Tool-specific files (e.g. `CLAUDE.md`) defer to this
document. Directory-specific rules live in nested `AGENTS.md` files and
hard-won lessons in `docs/lessons/` — load both on demand as described below;
never preload everything.

## How to work

- Every edit happens in a worktree branched off freshly-fetched `origin/main`
  (`.claude/worktrees/<type>-<name>`, branch renamed to `<type>/<name>`) —
  never in the main checkout.
- TDD is non-negotiable: write the test first, watch it fail, then implement.
  Every feature and bug fix ships with tests.
- Quality over speed. These guidelines are binding — when code can't comply,
  say so rather than silently working around them.
- Reuse before you create — search for an existing component, type, field, or
  util before adding one. Server Components, Server Actions for mutations, and
  named exports are the default posture.
- Gate before committing — all four must pass:
  `pnpm run typecheck && pnpm run test:run && pnpm run lint && pnpm run format`.

## Hard constraints

1. **Secrets and `.env*`** — never read, print, copy, decrypt, or pipe the
   contents of `.env*`, `.envrc`, `*.pem`, `*.key`, `id_*`, `.aws/credentials`,
   `.npmrc`, `~/.config/gh/hosts.yml`, or any secret-bearing file — with any
   tool, even piped through `head`/`wc` or redirected; running the command
   captures the value regardless. Never quote or log any value from them, even
   partially; never run `git diff`/`show`/`log -p`/`grep` on paths that may
   contain secrets without confirming the path is safe. Treat all `.env*` as
   production secrets (gitignored / "dev only" does not make them safe);
   refuse pasted `.env` content. Redact to `***` any env var matching
   `*_URL`, `*SECRET*`, `*TOKEN*`, `*KEY*`, `*PASSWORD*`, `*PASSWD*`,
   `*CREDENTIAL*`, `*DSN*`, `*CONNECTION*` before it could appear in output.
   If a task "needs" a secret value, ask for a placeholder. If a secret (even
   partial) appears in any output or input: stop, tell the user it must be
   rotated, do not repeat it, and wait.

## Directory guides (load on demand)

Before working under a directory, read its `AGENTS.md`:

| File                                     | Covers                                                              |
| ---------------------------------------- | ------------------------------------------------------------------- |
| [`src/AGENTS.md`](src/AGENTS.md)         | Architecture, TypeScript rules, data fetching, unit testing, naming |
| [`src/app/AGENTS.md`](src/app/AGENTS.md) | Components, forms, styling, accessibility, performance              |
| [`src/lib/AGENTS.md`](src/lib/AGENTS.md) | Server Actions, repositories, services, validation, decorators      |

## Lessons (load on demand)

Hard-won, repo-specific lessons live in `docs/lessons/<category>/` — one file
per lesson. Never preload them all. Before starting work that matches a
category, read every file in that category's directory, recursing into any
subdirectories:

| Category        | Load before                                      |
| --------------- | ------------------------------------------------ |
| `git-workflow/` | branching, committing, pushing, PRs, code review |
| `react-nextjs/` | UI components, dynamic imports, Radix, bundling  |
| `testing/`      | writing or debugging unit tests, vitest mocks    |
| `tooling/`      | shell-heavy work, lint config, stress-repro runs |
| `validation/`   | Zod schemas, validating external input           |

When corrected — or when you catch your own mistake — add the lesson as a new
file in the matching category (create a new category directory if none fits)
before continuing, so it never happens again.

## Stack

Versions track `package.json` — update this block when they change.

- TypeScript 7 (strict), Node 24 (from `.nvmrc`, never global), pnpm 11 —
  `pnpm exec` for CLI tools (`tsx`, `oxlint`, `vitest`, …).
- Next.js 16 (App Router, Turbopack dev, webpack build), React 19.
- shadcn/ui (Radix), Tailwind v4, lucide-react, RHF 7 + Zod 4;
  TanStack Query 5; Vitest 4
- oxlint 1 (`.oxlintrc.json`), not ESLint — typescript-eslint hard-throws on
  TypeScript 7, so the whole ESLint stack is incompatible with this repo's
  compiler. oxlint parses TS natively in Rust and has no `typescript` peer.
  See `docs/lessons/tooling/typescript-7-has-no-js-compiler-api.md`.
  `eslint-plugin-security`, `eslint-plugin-better-tailwindcss`, and
  `eslint-plugin-simple-import-sort` still run, loaded through oxlint's
  `jsPlugins` bridge. **`jsPlugins` is alpha and not subject to semver** —
  this is an accepted, deliberate risk. If an oxlint bump makes those rule
  sets vanish, that is the cause; pin oxlint rather than deleting the rules.
- Import order is `simple-import-sort` (not `import/order`, which oxlint
  lacks and whose namespace would collide with oxlint's built-in `import`
  plugin). Groups: side-effect → `node:` → react → next → external → `@/` →
  parent → sibling, blank line between each. Always autofixable — run
  `pnpm run lint`, never hand-sort.
- Arrow functions are enforced by core `func-style` + `prefer-arrow-callback`,
  both native to oxlint. App Router special files (`page`, `layout`, `route`,
  …) are exempt in `.oxlintrc.json`, matching the old ESLint setup.
  `eslint-plugin-perfectionist` and `eslint-plugin-prefer-arrow-functions`
  are **not** options here — both depend on `@typescript-eslint/utils` and
  would reintroduce the TS 7 break.
- `PageProps` / `LayoutProps` / `RouteContext` are Next-generated globals, not
  imports. They only exist after `next dev`, `next build`, or `next typegen`,
  which is why `typecheck` runs typegen first — and why lint-staged's staged
  gate calls `pnpm run typecheck` rather than `tsc` directly. A fresh clone
  therefore needs no manual typegen before its first commit.
- lint-staged is configured in `lint-staged.config.mjs`, **not** in
  `package.json` — the TypeScript entry has to be a function
  (`() => 'pnpm run typecheck'`), which JSON cannot express. lint-staged
  appends staged filenames to every string command, and passing input files to
  `tsc` on the CLI makes it ignore `tsconfig.json` and compile with default
  options. The function form is lint-staged's documented escape hatch; keep it.
  `tsc-files` used to fill this role and was removed — under pnpm's isolated
  store it never spawned a compiler and exited 0 on everything.
  See `docs/lessons/tooling/tsc-files-silently-passes-under-pnpm.md`.
- Vitest transforms with **oxc**, not esbuild — an `esbuild` block in
  `vitest.config.ts` is silently ignored. Use `oxc: { target: … }`.

## Commands

```bash
pnpm run dev                  # Dev server (Turbopack)
pnpm run build                # Production build (webpack)
pnpm run test:run             # Unit tests once (test = watch mode)
pnpm run typegen              # Generate .next/types (PageProps, LayoutProps, …)
pnpm run typecheck            # next typegen && tsc --noEmit
pnpm run lint                 # oxlint check + auto-fix (--max-warnings 0)
pnpm run format               # Prettier write (format:check = no write)
```

## Commits & git hooks

- Conventional Commits, enforced by commitlint: header ≤50 chars INCLUDING the
  `type(scope): ` prefix and gitmoji (counts as 2); body/footer lines ≤72.
  Format `type(scope): <gitmoji> subject` — `feat: ✨`, `fix: 🐛`,
  `refactor: ♻️`, `perf: ⚡`, `docs: 📝`, `test: ✅`, `chore: 🔧`, `style: 🎨`.
  The type drives the automated version bump + `CHANGELOG.md` — pick it
  accurately.
- Never commit or push to `main`; never bypass hooks with `--no-verify`; never
  add AI attribution / `Co-authored-by` lines. Atomic commits when working
  autonomously.
- Husky: **pre-commit** blocks `main`, runs gitleaks, lint-staged, and
  `vitest --changed`; **pre-push** requires up-to-date with `origin/main`,
  rejects WIP/`fixup!` commits, runs `tsc --noEmit`, and lint; **post-merge** reinstalls deps

## Conventions

- Secure defaults always (CORS, cookie flags, rate limits); least privilege;
  validate and sanitize all external input. Config and secrets in env vars —
  never hardcoded. Auth cookies are `httpOnly`/`secure`/`sameSite`; web
  storage only for non-sensitive client state.
- Dependencies: reuse an existing one before adding (check `package.json`);
  weigh bundle size, maintenance, security, and MIT compatibility.
- When editing a line, confirm nearby comments are still accurate.
- Refactor with confidence — tests, types, and review catch mistakes. Update
  or remove tests to match the new structure; no orphaned tests or code.
