import { afterEach, describe, expect, it } from 'vitest';
import { ClockProvider } from '../src/clock-provider.js';
import { Utils } from '../src/utils.js';

describe('ClockProvider', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('now() returns current time', () => {
    const before = Date.now();
    const now = ClockProvider.now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('setClock() overrides', () => {
    ClockProvider.setClock(() => 1_000_000);
    expect(ClockProvider.now()).toBe(1_000_000);
  });

  it('resetClock() restores default', () => {
    ClockProvider.setClock(() => 42);
    ClockProvider.resetClock();
    const now = ClockProvider.now();
    expect(now).toBeGreaterThan(1_000_000);
  });
});

describe('Utils', () => {
  it('getHostname returns non-empty string', () => {
    expect(Utils.getHostname().length).toBeGreaterThan(0);
  });

  it('toIsoString(0) returns epoch start', () => {
    expect(Utils.toIsoString(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('toIsoString produces 3-digit millis', () => {
    expect(Utils.toIsoString(1_544_185_837_810)).toBe('2018-12-07T12:30:37.810Z');
  });
});
