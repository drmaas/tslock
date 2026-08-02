import { type DurationInput, parseDuration } from '@tslock/core';
import type { LockedBody } from './lock-metadata.js';
import { type LockNameStrategy, methodPathStrategy } from './lock-name-strategy.js';

export interface MiddlewareConfig {
  lockProvider: import('@tslock/core').LockProvider;
  lockAtMostFor: DurationInput;
  lockAtLeastFor: DurationInput;
  lockNamePrefix: string;
  defaultLockedStatus: number;
  defaultLockedBody: unknown;
  lockNameStrategy: LockNameStrategy;
}

/** Treat route configuration as immutable after registering it with a framework factory. */
export interface RouteLockConfig {
  name?: string;
  lockAtMostFor?: DurationInput;
  lockAtLeastFor?: DurationInput;
  lockedStatus?: number;
  lockedBody?: unknown;
}

export interface ResolvedRouteConfig {
  lockAtMostFor: number;
  lockAtLeastFor: number;
  lockedStatus: number;
  lockedBody: LockedBody | undefined;
}

interface ResolvedDurations {
  lockAtMostFor: number;
  lockAtLeastFor: number;
}

const DEFAULTS = {
  lockAtMostFor: 30000 as DurationInput,
  lockAtLeastFor: 0 as DurationInput,
  lockNamePrefix: '',
  defaultLockedStatus: 503,
  defaultLockedBody: undefined as unknown,
};

const durationCache = new WeakMap<MiddlewareConfig, ResolvedDurations>();
const routeCache = new WeakMap<MiddlewareConfig, WeakMap<RouteLockConfig, ResolvedRouteConfig>>();
const globalRouteCache = new WeakMap<MiddlewareConfig, ResolvedRouteConfig>();

export function snapshotRouteConfig(route?: RouteLockConfig): RouteLockConfig | undefined {
  return route === undefined ? undefined : Object.freeze({ ...route });
}

export function resolveMiddlewareConfig(
  input: Partial<Omit<MiddlewareConfig, 'lockProvider'>> & { lockProvider: MiddlewareConfig['lockProvider'] },
): MiddlewareConfig {
  const config = Object.freeze({
    lockProvider: input.lockProvider,
    lockAtMostFor: input.lockAtMostFor ?? DEFAULTS.lockAtMostFor,
    lockAtLeastFor: input.lockAtLeastFor ?? DEFAULTS.lockAtLeastFor,
    lockNamePrefix: input.lockNamePrefix ?? DEFAULTS.lockNamePrefix,
    defaultLockedStatus: input.defaultLockedStatus ?? DEFAULTS.defaultLockedStatus,
    defaultLockedBody: input.defaultLockedBody ?? DEFAULTS.defaultLockedBody,
    lockNameStrategy: input.lockNameStrategy ?? methodPathStrategy,
  });

  durationCache.set(config, {
    lockAtMostFor: parseDuration(config.lockAtMostFor),
    lockAtLeastFor: parseDuration(config.lockAtLeastFor),
  });
  return config;
}

function resolvedDurations(global: MiddlewareConfig): ResolvedDurations {
  const cached = durationCache.get(global);
  if (cached) return cached;
  const resolved = {
    lockAtMostFor: parseDuration(global.lockAtMostFor),
    lockAtLeastFor: parseDuration(global.lockAtLeastFor),
  };
  durationCache.set(global, resolved);
  return resolved;
}

/** Resolves a route configuration and caches only frozen route snapshots. */
export function mergeRouteConfig(global: MiddlewareConfig, route?: RouteLockConfig): ResolvedRouteConfig {
  if (!route) {
    const cached = globalRouteCache.get(global);
    if (cached) return cached;
    const durations = resolvedDurations(global);
    const resolved = {
      lockAtMostFor: durations.lockAtMostFor,
      lockAtLeastFor: durations.lockAtLeastFor,
      lockedStatus: global.defaultLockedStatus,
      lockedBody: global.defaultLockedBody as LockedBody | undefined,
    };
    globalRouteCache.set(global, resolved);
    return resolved;
  }

  const canCache = Object.isFrozen(route);
  let routesForGlobal = routeCache.get(global);
  if (canCache && !routesForGlobal) {
    routesForGlobal = new WeakMap<RouteLockConfig, ResolvedRouteConfig>();
    routeCache.set(global, routesForGlobal);
  }
  const cached = canCache ? routesForGlobal?.get(route) : undefined;
  if (cached) return cached;

  const durations = resolvedDurations(global);
  const resolved = {
    lockAtMostFor: route.lockAtMostFor !== undefined ? parseDuration(route.lockAtMostFor) : durations.lockAtMostFor,
    lockAtLeastFor: route.lockAtLeastFor !== undefined ? parseDuration(route.lockAtLeastFor) : durations.lockAtLeastFor,
    lockedStatus: route.lockedStatus ?? global.defaultLockedStatus,
    lockedBody: (route.lockedBody ?? global.defaultLockedBody) as LockedBody | undefined,
  };
  if (canCache) routesForGlobal?.set(route, resolved);
  return resolved;
}
