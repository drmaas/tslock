import type { LockProvider } from '@tslock/core';
import type { LockFailureResponse, MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';
import { createLockMiddlewareLifecycle, resolveMiddlewareConfig, snapshotRouteConfig } from '@tslock/middleware-core';
import type { Context, Middleware } from 'koa';

export interface KoaLockFactory {
  (routeConfig?: RouteLockConfig): Middleware;
  lockProvider: LockProvider;
  config: MiddlewareConfig;
}

export function createKoaLock(
  input: Partial<Omit<MiddlewareConfig, 'lockProvider'>> & { lockProvider: LockProvider },
): KoaLockFactory {
  const config = resolveMiddlewareConfig(input);
  const lifecycle = createLockMiddlewareLifecycle(config);

  const factory = ((routeConfig?: RouteLockConfig): Middleware => {
    const registeredRouteConfig = snapshotRouteConfig(routeConfig);
    return async (ctx, next) => {
      const path = (ctx as Context & { _matchedRoute?: string })._matchedRoute ?? ctx.path;

      const runHandler = async () => {
        await next();
      };

      const sendLockedResponse = async (result: LockFailureResponse) => {
        ctx.status = result.status;
        ctx.set(result.headers);
        ctx.body = result.body;
      };

      await lifecycle.executeWithLock(
        { method: ctx.method, path },
        registeredRouteConfig,
        runHandler,
        sendLockedResponse,
      );
    };
  }) as KoaLockFactory;

  factory.lockProvider = config.lockProvider;
  factory.config = config;

  return factory;
}
