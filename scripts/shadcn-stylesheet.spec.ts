import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import packageJson from '../package.json' with { type: 'json' };

/**
 * Guards the decision to keep the `shadcn` package out of this project.
 *
 * The app needs exactly one thing from it: a stylesheet of keyframes, custom
 * variants and utilities. The package that ships that stylesheet is the shadcn
 * CLI, and installing it brings the CLI's whole dependency tree along — an MCP
 * server, express, hono, undici, fast-glob and some 220 packages in all. That
 * tree was the only route to 7 of the 16 vulnerable packages in the 2026-10
 * audit, including one with no fix at all (`braces`, GHSA-vfj7-8cjw-p6xm).
 *
 * So the stylesheet is vendored as `src/app/shadcn.css` and the CLI is run on
 * demand with `pnpm dlx shadcn@latest`, which is what the README has always
 * documented. `shadcn init` undoes both halves of that — it adds the dependency
 * and rewrites the import — so these tests exist to make that visible.
 */
const REPO_ROOT = path.join(import.meta.dirname, '..');

const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('vendored shadcn stylesheet', () => {
  it.each([
    ['dependencies', packageJson.dependencies],
    ['devDependencies', packageJson.devDependencies],
  ])('keeps the shadcn CLI package out of %s', (_field, dependencies) => {
    expect(Object.keys(dependencies)).not.toContain('shadcn');
  });

  it('imports the vendored stylesheet', () => {
    expect(read('src/app/globals.css')).toContain("@import './shadcn.css';");
  });

  it('does not import the stylesheet from the package', () => {
    expect(read('src/app/globals.css')).not.toMatch(/@import\s+['"]shadcn\//);
  });

  // The copy cannot be compared against the package it came from — that package
  // is deliberately not installed — so the file itself has to say which release
  // it mirrors, or nobody can tell how stale it is.
  it('records the shadcn release the stylesheet was copied from', () => {
    expect(read('src/app/shadcn.css')).toMatch(/Copied from shadcn@\d+\.\d+\.\d+/);
  });
});
