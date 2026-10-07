import type { LockProvider } from '@tslock/core';
import type { LockFailureResponse, MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';
import {
  createLockMiddlewareLifecycle,
  mergeRouteConfig,
  resolveMiddlewareConfig,
  snapshotRouteConfig,
} from '@tslock/middleware-core';
import type { Request, RequestHandler } from 'express';

export interface ExpressLockFactory {
  (routeConfig?: RouteLockConfig): RequestHandler;
  lockProvider: LockProvider;
  config: MiddlewareConfig;
}

function normalizeExpressLockPath(path: string, caseSensitive: boolean, strict: boolean): string {
  let normalized = path;
  if (!caseSensitive) {
    normalized = normalized.toLowerCase();
  }
  if (!strict && normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function resolveExpressLockPath(req: Request): string {
  const caseSensitive = Boolean(req.app?.get?.('case sensitive routing'));
  const strict = Boolean(req.app?.get?.('strict routing'));
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const routeSegment =
    req.route != null && req.route.path != null ? String(req.route.path) : typeof req.path === 'string' ? req.path : '';
  return normalizeExpressLockPath(`${baseUrl}${routeSegment}`, caseSensitive, strict);
}

export function createExpressLock(
  input: Partial<Omit<MiddlewareConfig, 'lockProvider'>> & { lockProvider: LockProvider },
): ExpressLockFactory {
  const config = resolveMiddlewareConfig(input);
  const lifecycle = createLockMiddlewareLifecycle(config);

  const factory = ((routeConfig?: RouteLockConfig): RequestHandler => {
    const registeredRouteConfig = snapshotRouteConfig(routeConfig);
    const lockAtMostMs = mergeRouteConfig(config, registeredRouteConfig).lockAtMostFor;
    return (req, res, next) => {
      void (async () => {
        try {
          const runHandler = () =>
            new Promise<void>((resolve) => {
              let settled = false;
              const onFinish = () => {
                if (!settled) {
                  settled = true;
                  cleanup();
                  resolve();
                }
              };
              const onClose = () => {
                if (!settled) {
                  settled = true;
                  cleanup();
                  resolve();
                }
              };
              const timeout = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  cleanup();
                  resolve();
                }
              }, lockAtMostMs);
              const cleanup = () => {
                clearTimeout(timeout);
                res.off('finish', onFinish);
                res.off('close', onClose);
              };
              res.on('finish', onFinish);
              res.on('close', onClose);
              next();
            });

          const sendLockedResponse = async (result: LockFailureResponse) => {
            res.status(result.status).set(result.headers).json(result.body);
          };

          await lifecycle.executeWithLock(
            { method: req.method, path: resolveExpressLockPath(req) },
            registeredRouteConfig,
            runHandler,
            sendLockedResponse,
          );
        } catch (err) {
          next(err);
        }
      })();
    };
  }) as ExpressLockFactory;

  factory.lockProvider = config.lockProvider;
  factory.config = config;

  return factory;
}
