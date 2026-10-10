# next-kitchen-sink

A starter template for Next.js applications — App Router, React 19, TypeScript 7, Tailwind v4, shadcn/ui, and TanStack
Query, wired up with a full test and quality-gate toolchain so a new project starts at production standards instead of
growing into them.

## Initialising a generated project

This is a GitHub template repository. Generate a project from it, then run the one-shot initialiser:

```bash
gh repo create <org>/my-app --template braveneworg/next-kitchen-sink --private --clone
cd my-app
pnpm install            # also installs the Husky hooks via `prepare`
pnpm run init-template  # rewrites the template's identity, then deletes itself
```

`init-template` takes the project name from the `origin` remote — override it with `--name`, and set the blurb and
copyright holder with `--description` and `--author`. It rewrites `package.json` (name, description, version reset to
`0.1.0`, template-only keywords dropped), `README.md`, `LICENSE`, and `COVERAGE_METRICS.md` — reseeding the coverage
baseline from `vitest.config.ts`'s thresholds rather than inheriting this template's own numbers. It also removes
`docs/lessons/` and every deep link into it — those files record incidents from this repository's history, not the new
project's — leaving the convention in `AGENTS.md` so the new project writes its own. It then deletes itself, its spec,
and this section. Preview the whole thing with `--dry-run`.

The coverage baseline matters most here: a generated project inherits `COVERAGE_METRICS.md`, and the template's own
100% is not the new project's achievement. `init-template` reseeds it from the thresholds, so the regression gate is
meaningful from the first run without failing the moment an uncovered line appears.

> Generated projects are one-way copies. They share no history with this template and have no upstream link, so
> improvements made here do not flow into projects already generated.

## Tech stack

| Area         | Choice                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------- |
| Framework    | [Next.js 16](https://nextjs.org) — App Router, Turbopack in dev, webpack for production builds      |
| UI runtime   | [React 19](https://react.dev) — Server Components by default                                        |
| Language     | [TypeScript 7](https://www.typescriptlang.org) in strict mode                                       |
| Styling      | [Tailwind CSS v4](https://tailwindcss.com) via `@tailwindcss/postcss`, plus `tw-animate-css`        |
| Components   | [shadcn/ui](https://ui.shadcn.com) (`base-nova` style) on [Base UI](https://base-ui.com) primitives |
| Icons        | [lucide-react](https://lucide.dev)                                                                  |
| Server state | [TanStack Query 5](https://tanstack.com/query) + devtools                                           |
| Forms        | [React Hook Form 7](https://react-hook-form.com) + [Zod 4](https://zod.dev)                         |
| Testing      | [Vitest 4](https://vitest.dev), Testing Library, happy-dom/jsdom, v8 coverage                       |
| Linting      | [oxlint 1](https://oxc.rs) — **not** ESLint (see [Why oxlint](#why-oxlint-and-not-eslint))          |
| Formatting   | [Prettier 3](https://prettier.io) + `prettier-plugin-tailwindcss`                                   |
| Git hooks    | [Husky 9](https://typicode.github.io/husky), lint-staged, commitlint (Conventional Commits)         |

Also included and ready to use: `recharts` (charts), `embla-carousel-react` (carousels), `cmdk` (command palette),
`react-day-picker` + `date-fns` (dates), `input-otp` (OTP inputs), `react-resizable-panels` (split panes),
`html-react-parser` (HTML rendering), and `clsx` / `tailwind-merge` / `class-variance-authority` (class composition).

## Requirements

| Requirement  | Version   | Notes                                                                                                                              |
| ------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**  | `24.18.0` | Pinned in `.nvmrc` and enforced by `engines`. Use a version manager (`nvm use`), not a global install.                             |
| **pnpm**     | `12.10.1` | Pinned via `packageManager`. Enable with `corepack enable`.                                                                        |
| **gitleaks** | any       | _Optional but recommended._ The pre-commit hook scans staged changes for secrets and warns (does not fail) if gitleaks is missing. |

## Getting started

```bash
# 1. Use the pinned Node version
nvm install && nvm use

# 2. Enable pnpm via corepack (matches the pinned packageManager)
corepack enable

# 3. Install dependencies — this also installs Husky hooks via `prepare`
pnpm install

# 4. Start the dev server
pnpm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000).

Optional, recommended for the secret-scanning hook:

```bash
brew install gitleaks   # or see https://github.com/gitleaks/gitleaks
```

> `PageProps`, `LayoutProps`, and `RouteContext` are globals Next generates into `.next/types` — they don't exist until
> `next dev`, `next build`, or `next typegen` has run. Nothing here requires you to run `typegen` by hand: `pnpm run dev`
> and `pnpm run build` generate them, and `pnpm run typecheck` (which the pre-commit hook calls) runs `next typegen`
> first. `pnpm run typegen` exists for the case where you want the types without starting anything.

## Scripts

### Development

| Script             | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `pnpm run dev`     | Dev server with Turbopack                                 |
| `pnpm run build`   | Production build (webpack)                                |
| `pnpm run start`   | Serve the production build                                |
| `pnpm run typegen` | Generate `.next/types` without starting a server or build |

### Quality gates

Run all four before committing:

| Script               | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `pnpm run typecheck` | `next typegen` then `tsc --noEmit`                        |
| `pnpm run test:run`  | Full test suite, once                                     |
| `pnpm run lint`      | oxlint with `--fix`, zero warnings tolerated              |
| `pnpm run format`    | Prettier write (`format:check` to verify without writing) |

```bash
pnpm run typecheck && pnpm run test:run && pnpm run lint && pnpm run format
```

Run them as separate commands, not piped — piping hides a non-zero exit from an earlier stage.

### Testing

| Script                         | What it does                                                                |
| ------------------------------ | --------------------------------------------------------------------------- |
| `pnpm run test`                | Watch mode, dot reporter, quiet                                             |
| `pnpm run test:run`            | Single run — use this in CI                                                 |
| `pnpm run test:watch`          | Watch mode with full reporter output                                        |
| `pnpm run test:ui`             | Vitest browser UI                                                           |
| `pnpm run test:coverage`       | Coverage report into `coverage/`                                            |
| `pnpm run test:coverage:check` | Coverage plus the regression gate in `scripts/check-coverage-regression.ts` |

Coverage thresholds are 95% for statements, branches, functions, and lines, with a 2% regression tolerance. See
[`COVERAGE_METRICS.md`](COVERAGE_METRICS.md) for the full policy.

## Project structure

```
src/
├── app/                    # App Router — routes, layouts, and pages
│   ├── globals.css         # Tailwind entry + design tokens
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   └── ui/                 # shadcn/ui primitives
├── hooks/
│   └── queries/            # TanStack Query hooks
└── lib/                    # Server Actions, repositories, services, utils
scripts/                    # Repo tooling (coverage regression check)
docs/lessons/               # Repo-specific lessons, grouped by category
```

### Path aliases

| Alias            | Resolves to           |
| ---------------- | --------------------- |
| `@/*`            | `src/*`               |
| `@/components/*` | `src/components/*`    |
| `@/ui/*`         | `src/components/ui/*` |
| `@/lib/*`        | `src/lib/*`           |
| `@/utils/*`      | `src/lib/utils/*`     |
| `@/hooks/*`      | `src/hooks/*`         |

## Adding shadcn/ui components

```bash
pnpm dlx shadcn@latest add <component>
```

Components land in `src/components/ui` per `components.json`. The template ships the full primitive set already, so
check there before adding anything.

`shadcn` is deliberately not a dependency. The CLI runs on demand through `pnpm dlx`, and the one file the app needs
from the package — its Tailwind stylesheet — is vendored as [`src/app/shadcn.css`](src/app/shadcn.css). Installing the
package for that file would add the CLI's whole dependency tree, about 220 packages, to every project created from this
template. The header of that file says which release it mirrors and how to refresh it. Avoid `shadcn init`: it re-adds
the dependency and rewrites the import, and `scripts/shadcn-stylesheet.spec.ts` will fail until both are undone.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org) with a gitmoji:
  `type(scope): <gitmoji> subject`. Header ≤50 characters, body and footer lines ≤72. commitlint enforces this in the
  `commit-msg` hook.
- **Git hooks** (Husky): `pre-commit` blocks commits to `main`, scans for secrets, runs lint-staged and tests for
  changed files; `pre-push` requires the branch to be current with `origin/main`, rejects WIP commits, and runs the
  full gate (typecheck, lint, format check, tests plus the coverage regression check); `post-merge` reinstalls
  dependencies when the lockfile or `package.json` moved. Machinery shared between the four lives in
  [`.husky/lib.sh`](.husky/lib.sh), and each hook's behaviour is covered by a spec in [`scripts/`](scripts).
- **Imports** are sorted automatically by `simple-import-sort` — run `pnpm run lint`, never hand-sort.
- **Tests** are written first. Every feature and bug fix ships with them.
- **lint-staged** is configured in [`lint-staged.config.mjs`](lint-staged.config.mjs), not `package.json`. Its
  TypeScript entry must stay a function — lint-staged appends staged filenames to string commands, and passing input
  files to `tsc` makes it ignore `tsconfig.json` and pass on code the build rejects. Its globs are also the whole of
  what the staged gate covers: a directory with no entry is committed unlinted, so add one when you add code.

Full contributor and AI-agent guidelines live in [`AGENTS.md`](AGENTS.md), with per-directory guides in
[`src/AGENTS.md`](src/AGENTS.md), [`src/app/AGENTS.md`](src/app/AGENTS.md), and [`src/lib/AGENTS.md`](src/lib/AGENTS.md).

## Why oxlint and not ESLint?

`typescript-eslint` hard-throws on TypeScript 7, which makes the entire ESLint stack incompatible with this project's
compiler. oxlint parses TypeScript natively in Rust and has no `typescript` peer dependency.

Three ESLint plugins are still used — `eslint-plugin-security`, `eslint-plugin-better-tailwindcss`, and
`eslint-plugin-simple-import-sort` — loaded through oxlint's `jsPlugins` bridge. **That bridge is alpha and not covered
by semver.** This is a deliberate, accepted trade-off. If an oxlint upgrade makes those rules silently disappear, that
is the cause: pin oxlint rather than deleting the rules.

See [`docs/lessons/tooling/typescript-7-has-no-js-compiler-api.md`](docs/lessons/tooling/typescript-7-has-no-js-compiler-api.md) for the full background.

## License

MIT © Michaux Kelley
