# src/lib/ — Server layer

Read with [`src/AGENTS.md`](../AGENTS.md).

- `actions/` — Server Actions, `'use server'` at top. Every action validates
  its args with Zod, wraps work in `try`/`catch`, and revalidates as needed.
- `services/` — business logic; components stay presentation-focused.
- `validation/` — Zod schemas for all external input.
- Mark server-only modules with `'server-only'` (specs mock it:
  `vi.mock('server-only', () => ({}))`).
