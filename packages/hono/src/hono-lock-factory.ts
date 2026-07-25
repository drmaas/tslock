import type { LockProvider } from '@tslock/core';
import type { LockFailureResponse, MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';
import { createLockMiddlewareLifecycle, resolveMiddlewareConfig } from '@tslock/middleware-core';
import type { Context } from 'hono';
import type { MiddlewareHandler } from 'hono/types';

function getRoutePath(c: Context): string {
  const req = c.req as Context['req'] & { routePath?: string };
  if (req.routePath && req.routePath !== '/*') {
    return req.routePath;
  }
  return c.req.path;
}

export interface HonoLockFactory {
  (routeConfig?: RouteLockConfig): MiddlewareHandler;
  lockProvider: LockProvider;
  config: MiddlewareConfig;
}

export function createHonoLock(
  input: Partial<Omit<MiddlewareConfig, 'lockProvider'>> & { lockProvider: LockProvider },
): HonoLockFactory {
  const config = resolveMiddlewareConfig(input);
  const lifecycle = createLockMiddlewareLifecycle(config);

  const factory = ((routeConfig?: RouteLockConfig): MiddlewareHandler =>
    async (c, next) => {
      const path = getRoutePath(c);

      const runHandler = async () => {
        await next();
      };

      const sendLockedResponse = async (result: LockFailureResponse) => {
        c.res = c.json(result.body, result.status as 200, result.headers);
      };

      await lifecycle.executeWithLock({ method: c.req.method, path }, routeConfig, runHandler, sendLockedResponse);
    }) as HonoLockFactory;

  factory.lockProvider = config.lockProvider;
  factory.config = config;

  return factory;
}
