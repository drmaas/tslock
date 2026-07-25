import type { FastifyLockFactory } from './fastify-lock-plugin.js';

declare module 'fastify' {
  interface FastifyInstance {
    tslock: FastifyLockFactory;
  }
}
