import type { LockProvider } from '@tslock/core';
import type { LockFailureResponse, MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';
import { createLockMiddlewareLifecycle, resolveMiddlewareConfig } from '@tslock/middleware-core';
import type { FastifyPluginCallback, preHandlerHookHandler } from 'fastify';

export interface FastifyLockFactory {
  (routeConfig?: RouteLockConfig): preHandlerHookHandler;
  lockProvider: LockProvider;
  config: MiddlewareConfig;
}

export function createFastifyLockPlugin(
  input: Partial<Omit<MiddlewareConfig, 'lockProvider'>> & { lockProvider: LockProvider },
): FastifyPluginCallback {
  const config = resolveMiddlewareConfig(input);
  const lifecycle = createLockMiddlewareLifecycle(config);

  const factory = ((routeConfig?: RouteLockConfig): preHandlerHookHandler =>
    (request, reply, done) => {
      void (async () => {
        try {
          const path = request.routeOptions?.url ?? request.url;

          const runHandler = () =>
            new Promise<void>((resolve, reject) => {
              done();
              reply.then(resolve, reject);
            });

          const sendLockedResponse = async (result: LockFailureResponse) => {
            reply.status(result.status).headers(result.headers).send(result.body);
          };

          await lifecycle.executeWithLock(
            { method: request.method, path },
            routeConfig,
            runHandler,
            sendLockedResponse,
          );
        } catch (err) {
          done(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    }) as FastifyLockFactory;

  factory.lockProvider = config.lockProvider;
  factory.config = config;

  const plugin: FastifyPluginCallback = (fastify, _opts, done) => {
    fastify.decorate('tslock', factory);
    done();
  };

  return plugin;
}
