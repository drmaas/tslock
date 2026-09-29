import 'reflect-metadata';
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { getSchedulerLockOptions, isSchedulerLockWrapped, runWithSchedulerLock } from './scheduler-lock.js';
import { getSchedulerLockRuntime } from './scheduler-lock-runtime.js';

export class SchedulerLockInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler();
    if (typeof handler !== 'function') {
      return next.handle();
    }
    const options = getSchedulerLockOptions(handler);
    if (!options || isSchedulerLockWrapped(handler)) {
      return next.handle();
    }
    return from(
      runWithSchedulerLock(getSchedulerLockRuntime(), options, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }
}

Injectable()(SchedulerLockInterceptor);
