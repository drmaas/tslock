import type { DurationInput } from '@tslock/core';
import type { LockNameStrategy } from './lock-name-strategy.js';

export interface MiddlewareConfig {
  lockProvider: import('@tslock/core').LockProvider;
  lockAtMostFor: DurationInput;
  lockAtLeastFor: DurationInput;
  lockNamePrefix: string;
  defaultLockedStatus: number;
  defaultLockedBody: unknown;
  lockNameStrategy: LockNameStrategy;
}

export interface RouteLockConfig {
  name?: string;
  lockAtMostFor?: DurationInput;
  lockAtLeastFor?: DurationInput;
  lockedStatus?: number;
  lockedBody?: unknown;
}

export interface ResolvedRouteConfig {
  lockName: string;
  lockAtMostFor: number;
  lockAtLeastFor: number;
  lockedStatus: number;
  lockedBody: unknown;
}

const DEFAULTS = {
  lockAtMostFor: 30000 as DurationInput,
  lockAtLeastFor: 0 as DurationInput,
  lockNamePrefix: '',
  defaultLockedStatus: 503,
  defaultLockedBody: undefined as unknown,
};

export function resolveMiddlewareConfig(
  input: Partial<Omit<MiddlewareConfig, 'lockProvider'>> & { lockProvider: MiddlewareConfig['lockProvider'] },
): MiddlewareConfig {
  return Object.freeze({
    lockProvider: input.lockProvider,
    lockAtMostFor: input.lockAtMostFor ?? DEFAULTS.lockAtMostFor,
    lockAtLeastFor: input.lockAtLeastFor ?? DEFAULTS.lockAtLeastFor,
    lockNamePrefix: input.lockNamePrefix ?? DEFAULTS.lockNamePrefix,
    defaultLockedStatus: input.defaultLockedStatus ?? DEFAULTS.defaultLockedStatus,
    defaultLockedBody: input.defaultLockedBody ?? DEFAULTS.defaultLockedBody,
    lockNameStrategy: input.lockNameStrategy ?? methodPathStrategy,
  });
}

export function mergeRouteConfig(global: MiddlewareConfig, route?: RouteLockConfig): ResolvedRouteConfig {
  return {
    lockName: route?.name ?? '',
    lockAtMostFor:
      typeof route?.lockAtMostFor !== 'undefined'
        ? parseDurationWrapper(route.lockAtMostFor)
        : parseDurationWrapper(global.lockAtMostFor),
    lockAtLeastFor:
      typeof route?.lockAtLeastFor !== 'undefined'
        ? parseDurationWrapper(route.lockAtLeastFor)
        : parseDurationWrapper(global.lockAtLeastFor),
    lockedStatus: route?.lockedStatus ?? global.defaultLockedStatus,
    lockedBody: route?.lockedBody ?? global.defaultLockedBody,
  };
}

import { parseDuration } from '@tslock/core';
import { methodPathStrategy } from './lock-name-strategy.js';

function parseDurationWrapper(input: DurationInput): number {
  return parseDuration(input);
}
