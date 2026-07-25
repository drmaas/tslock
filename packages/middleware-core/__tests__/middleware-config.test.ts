import { describe, expect, it } from 'vitest';
import type { MiddlewareConfig } from '../src/middleware-config.js';
import { mergeRouteConfig, resolveMiddlewareConfig } from '../src/middleware-config.js';

function mockLockProvider() {
  return {
    lock: async () => undefined,
  } as unknown as MiddlewareConfig['lockProvider'];
}

describe('resolveMiddlewareConfig', () => {
  it('fills defaults when only lockProvider is provided', () => {
    const lp = mockLockProvider();
    const config = resolveMiddlewareConfig({ lockProvider: lp });

    expect(config.lockProvider).toBe(lp);
    expect(config.lockAtMostFor).toBe(30000);
    expect(config.lockAtLeastFor).toBe(0);
    expect(config.lockNamePrefix).toBe('');
    expect(config.defaultLockedStatus).toBe(503);
    expect(config.defaultLockedBody).toBeUndefined();
    expect(config.lockNameStrategy).toBeDefined();
  });

  it('does not allow overriding lockProvider default', () => {
    const lp = mockLockProvider();
    const config = resolveMiddlewareConfig({ lockProvider: lp });

    expect(Object.isFrozen(config)).toBe(true);
  });

  it('overrides individual fields', () => {
    const lp = mockLockProvider();
    const config = resolveMiddlewareConfig({
      lockProvider: lp,
      lockAtMostFor: '10s',
      lockAtLeastFor: '5s',
      lockNamePrefix: 'myapp',
      defaultLockedStatus: 423,
    });

    expect(config.lockAtMostFor).toBe('10s');
    expect(config.lockAtLeastFor).toBe('5s');
    expect(config.lockNamePrefix).toBe('myapp');
    expect(config.defaultLockedStatus).toBe(423);
  });

  it('uses custom lockNameStrategy', () => {
    const lp = mockLockProvider();
    const customStrategy = (_method: string, _path: string) => 'custom';
    const config = resolveMiddlewareConfig({
      lockProvider: lp,
      lockNameStrategy: customStrategy,
    });

    expect(config.lockNameStrategy).toBe(customStrategy);
  });
});

describe('mergeRouteConfig', () => {
  function baseConfig(): MiddlewareConfig {
    const lp = mockLockProvider();
    return resolveMiddlewareConfig({ lockProvider: lp });
  }

  it('returns global defaults when no route config', () => {
    const global = baseConfig();
    const resolved = mergeRouteConfig(global);

    expect(resolved.lockName).toBe('');
    expect(resolved.lockAtMostFor).toBe(30000);
    expect(resolved.lockAtLeastFor).toBe(0);
    expect(resolved.lockedStatus).toBe(503);
    expect(resolved.lockedBody).toBeUndefined();
  });

  it('overrides lockAtMostFor from route', () => {
    const global = baseConfig();
    const resolved = mergeRouteConfig(global, { lockAtMostFor: '1m' });

    expect(resolved.lockAtMostFor).toBe(60000);
  });

  it('overrides lockAtLeastFor from route', () => {
    const global = baseConfig();
    const resolved = mergeRouteConfig(global, { lockAtLeastFor: '10s' });

    expect(resolved.lockAtLeastFor).toBe(10000);
  });

  it('overrides lockedStatus from route', () => {
    const global = baseConfig();
    const resolved = mergeRouteConfig(global, { lockedStatus: 423 });

    expect(resolved.lockedStatus).toBe(423);
  });

  it('overrides lockedBody from route', () => {
    const global = baseConfig();
    const body = { custom: 'error' };
    const resolved = mergeRouteConfig(global, { lockedBody: body });

    expect(resolved.lockedBody).toBe(body);
  });

  it('preserves name from route config', () => {
    const global = baseConfig();
    const resolved = mergeRouteConfig(global, { name: 'custom-name' });

    expect(resolved.lockName).toBe('custom-name');
  });

  it('default lockedStatus is 503', () => {
    const global = baseConfig();
    expect(global.defaultLockedStatus).toBe(503);
  });
});
