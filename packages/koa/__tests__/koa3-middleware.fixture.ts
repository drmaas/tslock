import type { LockProvider } from '@tslock/core';
import type { Middleware } from 'koa';
import { createKoaLock } from '../src/index.js';

export function acceptKoa3Middleware(lockProvider: LockProvider): Middleware {
  return createKoaLock({ lockProvider })();
}
