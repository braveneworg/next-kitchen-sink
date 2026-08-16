// Explicit ambient test types.
//
// Without this file the jest-dom matchers (`toBeInTheDocument`, `toHaveClass`,
// …) still resolve, but only as a side effect of the dynamic
// `import('@testing-library/jest-dom/vitest')` nested inside the
// `if (typeof window !== 'undefined')` block in `setupTests.ts` — jest-dom is
// not in tsconfig.json's `types` array. That is a fragile path to depend on:
// restructure that conditional, split the setup file per Vitest project, or
// narrow `types`, and every matcher silently degrades to `any`. Misspelled or
// removed matchers would then stop being type errors while the suite keeps
// passing.
//
// Declaring the references here anchors the matcher types to the compile
// itself. tsconfig.json picks this file up via its `**/*.ts` include.

/// <reference types="vitest/globals" />
/// <reference types="@testing-library/jest-dom/vitest" />
