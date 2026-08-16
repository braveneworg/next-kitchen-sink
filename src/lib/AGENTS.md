# src/lib/ — Server layer

Read with [`src/AGENTS.md`](../AGENTS.md).

> None of the subdirectories below ship with the template — `src/lib/` starts
> with just `utils.ts`. Create each one when you first need it; the layout here
> is the convention to follow, not a map of what is already present.

- `actions/` — Server Actions, `'use server'` at top. Every action validates
  its args with Zod, wraps work in `try`/`catch`, and revalidates as needed.
- `services/` — business logic; components stay presentation-focused.
- `validation/` — Zod schemas for all external input.
- Mark server-only modules with `'server-only'` (specs mock it:
  `vi.mock('server-only', () => ({}))`).
