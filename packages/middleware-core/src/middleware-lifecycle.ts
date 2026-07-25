import type { LockConfiguration } from '@tslock/core';
import { DefaultLockingTaskExecutor, Utils, createLockConfig } from '@tslock/core';
import type { LockFailureResponse } from './lock-metadata.js';
import { buildLockFailureResponse, defaultLockedBody } from './lock-metadata.js';
import { deriveLockName } from './lock-name-strategy.js';
import type { MiddlewareConfig, RouteLockConfig } from './middleware-config.js';
import { mergeRouteConfig } from './middleware-config.js';

export interface LockRequestContext {
  method: string;
  path: string;
}

export interface MiddlewareLockResult {
  wasExecuted: boolean;
}

export interface LockMiddlewareLifecycle {
  executeWithLock(
    ctx: LockRequestContext,
    routeConfig: RouteLockConfig | undefined,
    runHandler: () => Promise<void>,
    sendLockedResponse: (result: LockFailureResponse) => Promise<void>,
  ): Promise<MiddlewareLockResult>;
}

export function createLockMiddlewareLifecycle(config: MiddlewareConfig): LockMiddlewareLifecycle {
  const executor = new DefaultLockingTaskExecutor(config.lockProvider);

  return {
    async executeWithLock(ctx, routeConfig, runHandler, sendLockedResponse) {
      const resolved = mergeRouteConfig(config, routeConfig);
      const lockName = deriveLockName(
        config.lockNameStrategy,
        config.lockNamePrefix,
        ctx.method,
        ctx.path,
        routeConfig?.name ?? (resolved.lockName || undefined),
      );
      const lockConfig: LockConfiguration = createLockConfig(lockName, resolved.lockAtMostFor, resolved.lockAtLeastFor);

      const result = await executor.executeWithLock(runHandler, lockConfig);
      if (result.wasExecuted) {
        return { wasExecuted: true };
      }

      const now = Date.now();
      const lockUntil = now + resolved.lockAtMostFor;
      const body =
        typeof resolved.lockedBody !== 'undefined' && resolved.lockedBody !== null
          ? resolved.lockedBody
          : defaultLockedBody;
      const response = buildLockFailureResponse(resolved.lockedStatus, body, lockName, Utils.getHostname(), lockUntil);
      await sendLockedResponse(response);
      return { wasExecuted: false };
    },
  };
}
