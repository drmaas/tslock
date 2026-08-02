import { describe, expect, it } from 'vitest';
import type { MiddlewareConfig } from '../src/middleware-config.js';
import { mergeRouteConfig, resolveMiddlewareConfig, snapshotRouteConfig } from '../src/middleware-config.js';

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

    expect(mergeRouteConfig(global)).toBe(resolved);
    expect(resolved.lockAtMostFor).toBe(30000);
    expect(resolved.lockAtLeastFor).toBe(0);
    expect(resolved.lockedStatus).toBe(503);
    expect(resolved.lockedBody).toBeUndefined();
  });

  it('overrides lockAtMostFor from route', () => {
    const global = baseConfig();
    const route = { lockAtMostFor: '1m' as const };
    const resolved = mergeRouteConfig(global, route);

    expect(resolved.lockAtMostFor).toBe(60000);
    expect(mergeRouteConfig(global, route)).toEqual(resolved);
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

  it('preserves arbitrary public body values', () => {
    const body = new Date(0);
    const global = resolveMiddlewareConfig({ lockProvider: mockLockProvider(), defaultLockedBody: body });

    expect(mergeRouteConfig(global).lockedBody).toBe(body);
  });

  it('does not include a redundant lock name in the resolved config', () => {
    const global = baseConfig();
    const resolved = mergeRouteConfig(global, { name: 'custom-name' });

    expect('lockName' in resolved).toBe(false);
  });

  it('does not cache mutable route objects', () => {
    const global = baseConfig();
    const route = { lockAtMostFor: '1s' as const };
    const first = mergeRouteConfig(global, route);
    route.lockAtMostFor = '2s';
    const second = mergeRouteConfig(global, route);

    expect(first).not.toBe(second);
    expect(first.lockAtMostFor).toBe(1000);
    expect(second.lockAtMostFor).toBe(2000);
  });

  it('does not share route cache entries across global configs', () => {
    const route = { lockAtMostFor: '1s' as const };
    const first = mergeRouteConfig(
      resolveMiddlewareConfig({ lockProvider: mockLockProvider(), lockAtMostFor: '10s' }),
      route,
    );
    const second = mergeRouteConfig(
      resolveMiddlewareConfig({ lockProvider: mockLockProvider(), lockAtMostFor: '20s' }),
      route,
    );

    expect(first).not.toBe(second);
    expect(first.lockAtMostFor).toBe(1000);
    expect(second.lockAtMostFor).toBe(1000);
  });

  it('snapshots registered route configuration', () => {
    const route = { name: 'custom', lockAtMostFor: '1s' as const };
    const snapshot = snapshotRouteConfig(route);

    expect(snapshot).not.toBe(route);
    expect(Object.isFrozen(snapshot)).toBe(true);
    route.name = 'changed';
    expect(snapshot?.name).toBe('custom');
  });

  it('default lockedStatus is 503', () => {
    const global = baseConfig();
    expect(global.defaultLockedStatus).toBe(503);
  });
});
