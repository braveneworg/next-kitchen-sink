import { act, renderHook } from '@testing-library/react';

import { useIsMobile } from './use-mobile';

/** Must match MOBILE_BREAKPOINT in use-mobile.ts. */
const MOBILE_BREAKPOINT = 768;

type ChangeListener = () => void;

/**
 * Replaces the blanket `window.matchMedia` stub from setupTests with one that
 * records its listeners, so a `change` event can be replayed on demand and the
 * unmount cleanup can be asserted.
 */
const mockMatchMedia = () => {
  const listeners = new Set<ChangeListener>();
  const addEventListener = vi.fn((_event: string, listener: ChangeListener) => {
    listeners.add(listener);
  });
  const removeEventListener = vi.fn((_event: string, listener: ChangeListener) => {
    listeners.delete(listener);
  });

  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener,
    removeEventListener,
    dispatchEvent: vi.fn(),
  }));

  return { addEventListener, removeEventListener, emitChange: () => listeners.forEach((listener) => listener()) };
};

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

describe('useIsMobile', () => {
  it('reports false for a viewport wider than the breakpoint', () => {
    mockMatchMedia();
    setViewportWidth(1024);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it('reports true for a viewport narrower than the breakpoint', () => {
    mockMatchMedia();
    setViewportWidth(375);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);
  });

  it('treats a viewport exactly at the breakpoint as not mobile', () => {
    mockMatchMedia();
    setViewportWidth(MOBILE_BREAKPOINT);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it('queries one pixel below the breakpoint', () => {
    mockMatchMedia();
    setViewportWidth(1024);

    renderHook(() => useIsMobile());

    expect(window.matchMedia).toHaveBeenCalledWith(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  });

  it('re-reads the width when the media query reports a change', () => {
    const { emitChange } = mockMatchMedia();
    setViewportWidth(1024);

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      setViewportWidth(375);
      emitChange();
    });

    expect(result.current).toBe(true);
  });

  it('removes its change listener on unmount', () => {
    const { addEventListener, removeEventListener } = mockMatchMedia();
    setViewportWidth(1024);

    const { unmount } = renderHook(() => useIsMobile());
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
