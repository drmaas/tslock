import { ClockProvider } from '@tslock/core';
import { afterEach, describe, expect, it } from 'vitest';
import { MutableClock, withMutableClock } from '../src/clock-harness.js';

describe('MutableClock / withMutableClock', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('installs a controllable clock for skew simulations', async () => {
    await withMutableClock(1_000_000, (clock) => {
      expect(ClockProvider.now()).toBe(1_000_000);
      clock.advance(5_000);
      expect(ClockProvider.now()).toBe(1_005_000);
      clock.set(2_000_000);
      expect(ClockProvider.now()).toBe(2_000_000);
    });
    expect(ClockProvider.now()).toBeGreaterThan(1_000_000_000);
  });

  it('resets the clock when the callback throws', async () => {
    await expect(
      withMutableClock(42, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ClockProvider.now()).toBeGreaterThan(1_000_000_000);
  });

  it('MutableClock.install can be used without withMutableClock', () => {
    const clock = new MutableClock(500);
    clock.install();
    expect(ClockProvider.now()).toBe(500);
    ClockProvider.resetClock();
  });
});
