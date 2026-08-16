/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { cn } from './utils';

describe('cn', () => {
  it('joins plain class names', () => {
    expect(cn('flex', 'items-center')).toBe('flex items-center');
  });

  it('returns an empty string when given nothing', () => {
    expect(cn()).toBe('');
  });

  describe('clsx conditional handling', () => {
    it('drops falsy values', () => {
      expect(cn('flex', false, null, undefined, '')).toBe('flex');
    });

    it('keeps only the truthy keys of an object', () => {
      expect(cn({ flex: true, hidden: false })).toBe('flex');
    });

    it('flattens nested arrays', () => {
      expect(cn(['flex', ['items-center', 'gap-2']])).toBe('flex items-center gap-2');
    });

    it('resolves a conditional expression to the winning class', () => {
      const isActive = true;

      expect(cn(isActive ? 'opacity-100' : 'opacity-0')).toBe('opacity-100');
    });
  });

  describe('tailwind-merge conflict resolution', () => {
    it('keeps the last of two conflicting utilities', () => {
      expect(cn('p-4', 'p-8')).toBe('p-8');
    });

    it('lets a later class override an earlier one from a different argument', () => {
      expect(cn('text-black', { 'text-white': true })).toBe('text-white');
    });

    it('does not merge utilities that target different properties', () => {
      expect(cn('px-4', 'py-2')).toBe('px-4 py-2');
    });

    it('preserves a responsive variant alongside its base utility', () => {
      expect(cn('flex-col', 'sm:flex-row')).toBe('flex-col sm:flex-row');
    });

    it('collapses conflicting utilities that share a responsive variant', () => {
      expect(cn('sm:flex-col', 'sm:flex-row')).toBe('sm:flex-row');
    });
  });
});
