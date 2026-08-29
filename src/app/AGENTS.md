# src/app/ and src/components/ — UI: components, forms, styling

Read with [`src/AGENTS.md`](../AGENTS.md). Load `docs/lessons/react-nextjs/`
before UI or bundling work.

These rules cover both directories. Routes, layouts and pages live in
`src/app/`; every component lives in `src/components/`, outside the App Router
so that nothing under `app/` is anything but routing.

## Components

- Function components only — never class components. Keep them small; split
  large files. Destructure props with explicit types.
- State: React built-ins (`useState` / `useReducer` / `useContext`). Reach for
  an external store (Zustand, Redux) only when architectural complexity
  justifies it — not by default.
- React 19 concurrency where it improves UX: `useTransition` for non-urgent
  updates, `useDeferredValue` for expensive derived renders, `useId` for
  hydration-safe IDs.
- `globalThis`, not `window`, for client globals (SSR safety). Wrap risky
  subtrees in error boundaries; handle async failures gracefully. Never ship
  `console.log`. Never use `alert` / `prompt` — use
  shadcn/ui dialogs.

## Forms

- React Hook Form + Zod via `zodResolver`. Check
  `src/components/**/*` for an existing field before building one.

## Styling & accessibility

- Mobile-first; Tailwind v4 utilities only — no `@apply`, no inline styles.
  Compose conditional classes with `cn()`.
- Never create a new UI primitive — use shadcn/ui from `@/components/ui`.
  Icons from `lucide-react`; Never use checkboxes in
  mobile-first UIs — use toggles or radio buttons.
- Semantic HTML, ARIA, and keyboard navigation are required.

## Performance

- Code-split and lazy-load non-critical UI (`React.lazy` + `Suspense`,
  `next/dynamic`) with skeleton/Suspense fallbacks — but in the App Router
  `next/dynamic` never SSRs the real component.
- Use `next/image` for images. Memoize (`memo` / `useCallback` / `useMemo`)
  only where profiling shows it helps — never by default. Lean on TanStack
  Query caching instead of hand-rolled client caches.
