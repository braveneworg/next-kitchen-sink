import { createRequire } from 'node:module';
import * as path from 'node:path';

import { defineConfig, type ViteUserConfig } from 'vitest/config';

import packageJson from './package.json' with { type: 'json' };

// html-react-parser is hard to load under Vitest: its ESM entry is loaded
// natively by Node (so `server.deps.inline` never applies), and its server
// build of html-dom-parser require()s ESM-only `domhandler` and crashes. We
// force the CJS entry (so Vite inlines+transforms it, routing every require
// through Vite) and alias html-dom-parser to its DOMParser-based client build,
// which a browser-like DOM environment (happy-dom) satisfies without domhandler.
const require = createRequire(import.meta.url);
const htmlReactParserCjs = require.resolve('html-react-parser/lib/index');
const htmlDomParserClient = require.resolve('html-dom-parser/lib/client/html-to-dom');

// NOTE: a spec that imports html-react-parser needs its own `forks`-pool
// project. The default `vmThreads` pool ignores `server.deps.inline`, so the
// aliases above can't redirect html-dom-parser to its DOM-friendly client build
// and the CJS→ESM (`domhandler`) boundary crashes. The same applies to any
// native addon (`sharp` and friends), which vmThreads cannot reliably load.
// Add a project alongside the two below, scoped tightly to those spec files:
//
//   { extends: true, test: { name: 'jsdom-forks', environment: 'happy-dom',
//     pool: 'forks', include: ['**/my-parser.spec.tsx'] } }

// https://vitejs.dev/config/
export default defineConfig((): ViteUserConfig => {
  const withCoverage = process.argv.includes('--coverage');

  return {
    server: {
      open: true,
    },

    // Cache directory for faster subsequent builds
    cacheDir: 'node_modules/.vite',

    // Optimize build for faster test startup. Vite 8 / Vitest 4 transform with
    // oxc, not esbuild — an `esbuild` block here is silently ignored ("Both
    // esbuild and oxc options were set…"). Keep the target in sync with
    // tsconfig's `target`.
    oxc: {
      target: 'es2024',
    },

    test: {
      root: import.meta.dirname,
      silent: withCoverage ? false : 'passed-only', // Silence test output when not collecting coverage
      name: packageJson.name,
      environment: 'jsdom',
      // Use Vitest 4 workspace projects to split .spec.ts (node) and .spec.tsx
      // (happy-dom). Pure TypeScript spec files run in the lightweight Node
      // environment; skipping DOM init saves 1–3s wall clock. The .spec.ts files
      // that DO need DOM opt back in via a `// @vitest-environment jsdom` comment
      // at the top (jsdom is retained for those explicit opt-ins).
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: ['**/*.spec.ts'],
            exclude: ['**/node_modules/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'jsdom',
            environment: 'happy-dom',
            include: ['**/*.spec.tsx'],
            exclude: ['**/node_modules/**'],
          },
        },
      ],

      // Inline the html-react-parser CJS chain so Vite transforms every
      // `require()` through its resolver (applying the aliases below and
      // handling the ESM-only `domhandler`). See the alias note at the top.
      server: {
        deps: {
          inline: [/html-react-parser/, /html-dom-parser/, /domhandler/],
        },
      },

      // Performance optimizations
      css: false, // Don't process CSS in tests
      // vmThreads is ~3x faster than forks: thread startup is cheap, VM contexts
      // provide per-file isolation identical to forks without subprocess overhead.
      pool: 'vmThreads',

      // Use most cores, but leave headroom. Saturating every core (`'100%'`)
      // invites resource contention — workers spinning up simultaneously under
      // memory pressure can produce rare, non-deterministic VM-context failures
      // that pass on retry. On Apple Silicon it is also measurably SLOWER: a
      // maxWorkers sweep showed wall clock rising monotonically past ~10 workers
      // (9→21.4s, 10→21.7s, 14→22.5s) as work spilled onto efficiency cores.
      // `'75%'` (~10 workers on a 14-core box) keeps throughput at its peak while
      // reducing the flakiness risk.
      maxWorkers: '75%',

      isolate: true, // Required for test isolation
      fileParallelism: true, // Run test files in parallel for speed
      testTimeout: 5000,

      // Randomize test order to catch hidden dependencies, but ONLY within each
      // file (`tests: true`). File order stays UNSHUFFLED (`files: false`) so
      // Vitest's sequencer can schedule the slowest specs first and balance them
      // across workers — shuffling file order piles slow specs onto one worker at
      // the tail and nearly doubles wall clock (measured 23s → 13s here).
      // Use fixed seed for reproducibility, override with VITEST_SEED env var.
      sequence: {
        shuffle: { files: false, tests: true },
        seed: (() => {
          if (process.env.VITEST_SEED) {
            const parsed = parseInt(process.env.VITEST_SEED, 10);
            return Number.isNaN(parsed) || parsed <= 0 ? 42 : parsed;
          }
          return 42;
        })(),
      },

      // Disable typecheck by default for faster runs
      typecheck: {
        enabled: false,
      },

      // Fail fast on first error in CI for faster feedback
      bail: process.env.CI ? 1 : 0,

      globals: true,
      watch: false,
      setupFiles: ['./setupTests.ts'],
      // Auto-clear mock call history after every test — equivalent to calling
      // vi.clearAllMocks() in afterEach but eliminates the hook call overhead.
      clearMocks: true,

      // Optimize dependency pre-bundling
      deps: {
        optimizer: {
          web: {
            include: [
              '@testing-library/react',
              '@testing-library/jest-dom',
              '@testing-library/user-event',
              'react',
              'react-dom',
            ],
          },
        },
        // Inline small dependencies for faster loading
        interopDefault: true,
      },

      // Reporter optimizations
      reporters: process.env.CI ? ['default', 'junit'] : ['default'],
      outputFile: process.env.CI ? { junit: './test-results.xml' } : undefined,

      coverage: {
        provider: 'v8',
        thresholds: {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
        // In CI, only generate the reporters consumed downstream
        // (json-summary for coverage action + regression check, json for PR diff, text for log).
        // html/lcov/clover are large and unused in CI, and write significant disk I/O.
        reporter: process.env.CI ? ['text', 'json', 'json-summary'] : ['text', 'json', 'json-summary', 'html'],
        // Coverage is gathered exclusively from `.ts`/`.tsx` first-party source.
        // Plain `.js`/`.jsx`/`.cjs`/`.mjs`/`.json` files are tooling, generated
        // output, or third-party shims — explicitly drop them so they cannot
        // inflate or deflate the headline metrics.
        exclude: [
          '**/*.{js,jsx,cjs,mjs,json}',
          '**/*.css',
          // Configuration files
          '**/*.config.{ts,js,mjs,cjs}',
          '**/vitest.config.ts',
          '**/next.config.ts',
          '**/postcss.config.mjs',
          '**/tsconfig*.json',

          // Type declarations and interfaces
          '**/*.d.ts',
          '**/types/**',

          // Setup and tooling
          '**/setupTests.ts',

          // Build outputs and dependencies
          '**/node_modules/**',
          '**/dist/**',
          '**/build/**',
          '**/.next/**',
          '**/coverage/**',

          // Test files themselves
          '**/*.{test,spec}.{ts,tsx,js,jsx}',

          // Root layout — module-level code (env validation, HTTPS warning)
          // is not testable in jsdom/node environments
          '**/app/layout.tsx',

          // Scripts and utilities that don't need testing
          '**/scripts/**',

          // Mocks directory
          '**/__mocks__/**',

          // Test utilities - not production code
          '**/test-utils/**',

          // shadcn/ui primitives that wrap Base UI with no custom logic.
          // These only add styling/className and delegate all behaviour to the
          // underlying primitive, so unit tests would assert on class strings.
          // Anything here with real logic of its own should be removed from the
          // list and tested.
          '**/components/ui/context-menu.tsx',
          '**/components/ui/menubar.tsx',
          '**/components/ui/calendar.tsx',
          '**/components/ui/carousel.tsx',
          '**/components/ui/scroll-area.tsx',
          '**/components/ui/select.tsx',
          '**/components/ui/sidebar.tsx',
          '**/components/ui/chart.tsx',

          // CSS files
          '**/*.css',
        ],
      },

      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/coverage/**',
        '**/*.config.{ts,js,mjs,cjs}',
        '**/setupTests.ts',
        '**/e2e/**',
        '**/.claude/**',
        '**/.git/**',
      ],
    },

    resolve: {
      alias: [
        { find: /^html-react-parser$/, replacement: htmlReactParserCjs },
        { find: /^html-dom-parser$/, replacement: htmlDomParserClient },
        { find: '@/components', replacement: path.resolve(process.cwd(), './src/app/components') },
        { find: '@/lib', replacement: path.resolve(process.cwd(), './src/lib') },
        { find: '@/ui', replacement: path.resolve(process.cwd(), './src/app/components/ui') },
        { find: '@/hooks', replacement: path.resolve(process.cwd(), './src/hooks') },
        // Must stay ahead of the bare `@` entry — Vite matches aliases in array
        // order, so a broader prefix listed first would swallow this one. Keep
        // this list in sync with tsconfig.json's `paths`; a spec that resolves
        // differently from `tsc` is the hardest kind of test failure to read.
        { find: '@/utils', replacement: path.resolve(process.cwd(), './src/lib/utils') },
        { find: '@', replacement: path.resolve(process.cwd(), './src') },
      ],
      conditions: ['import', 'module', 'browser', 'default'],
      extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('test'),
    },
  };
});
