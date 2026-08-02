import type { LockProvider } from '@tslock/core';
import type { LockFailureResponse, MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';
import {
  createLockMiddlewareLifecycle,
  mergeRouteConfig,
  resolveMiddlewareConfig,
  snapshotRouteConfig,
} from '@tslock/middleware-core';
import type { RequestHandler } from 'express';

export interface ExpressLockFactory {
  (routeConfig?: RouteLockConfig): RequestHandler;
  lockProvider: LockProvider;
  config: MiddlewareConfig;
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
            { method: req.method, path: req.path },
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
