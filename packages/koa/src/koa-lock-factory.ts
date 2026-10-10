import type { LockProvider } from '@tslock/core';
import type { LockFailureResponse, MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';
import { createLockMiddlewareLifecycle, resolveMiddlewareConfig, snapshotRouteConfig } from '@tslock/middleware-core';
import type { Context, Middleware } from 'koa';

interface KoaRouterLockOptions {
  sensitive?: boolean;
  strict?: boolean;
}

type KoaLockContext = Context & {
  _matchedRoute?: unknown;
  router?: {
    opts?: KoaRouterLockOptions;
  };
};

function stripQueryString(path: string): string {
  const queryIndex = path.indexOf('?');
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

function normalizeKoaLockPath(path: string, sensitive: boolean, strict: boolean): string {
  let normalized = stripQueryString(path);
  if (!sensitive) {
    normalized = normalized.toLowerCase();
  }
  if (!strict && normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function resolveKoaLockPath(ctx: KoaLockContext): string {
  const matchedRoute = ctx._matchedRoute;
  const rawPath = typeof matchedRoute === 'string' && matchedRoute.length > 0 ? matchedRoute : ctx.path;
  const sensitive = ctx.router?.opts?.sensitive === true;
  const strict = ctx.router?.opts?.strict === true;
  return normalizeKoaLockPath(rawPath, sensitive, strict);
}

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
      const path = resolveKoaLockPath(ctx);

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
