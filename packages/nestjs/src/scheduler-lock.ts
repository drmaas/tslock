import { type DurationInput, LockException, Utils, createLockConfig, parseDuration } from '@tslock/core';
import { type SchedulerLockRuntime, getSchedulerLockRuntime } from './scheduler-lock-runtime.js';

export const SCHEDULER_LOCK_METADATA = Symbol.for('tslock.nestjs.SCHEDULER_LOCK');

const WRAPPED = Symbol.for('tslock.nestjs.SCHEDULER_LOCK_WRAPPED');

const optionsByHandler = new WeakMap<object, SchedulerLockOptions>();

export interface SchedulerLockOptions {
  name: string;
  lockAtMostFor?: DurationInput;
  lockAtLeastFor?: DurationInput;
}

interface MetadataReflect {
  getMetadataKeys?: (target: object) => unknown[];
  getMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
}

export function SchedulerLock(options: SchedulerLockOptions): MethodDecorator {
  validateSchedulerLockOptions(options);
  return (_target, _propertyKey, descriptor) => {
    const method = descriptor?.value;
    if (typeof method !== 'function') {
      throw new LockException('@SchedulerLock can only be applied to methods');
    }
    const original = method as (...args: unknown[]) => unknown;
    const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      return runWithSchedulerLock(getSchedulerLockRuntime(), options, async () => original.apply(this, args));
    };
    Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true });
    copyFunctionMetadata(original, wrapped);
    rememberSchedulerLockOptions(wrapped, options);
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    (descriptor as { value: unknown }).value = wrapped;
    return descriptor;
  };
}

export function getSchedulerLockOptions(handler: object): SchedulerLockOptions | undefined {
  const stored = optionsByHandler.get(handler);
  if (stored) return stored;
  const metadata = metadataReflect().getMetadata?.(SCHEDULER_LOCK_METADATA, handler);
  return isSchedulerLockOptions(metadata) ? metadata : undefined;
}

export function isSchedulerLockWrapped(handler: object): boolean {
  return Boolean(Reflect.get(handler, WRAPPED));
}

export async function runWithSchedulerLock<T>(
  runtime: SchedulerLockRuntime,
  options: SchedulerLockOptions,
  task: () => Promise<T>,
): Promise<T | undefined> {
  const config = createLockConfig(
    options.name,
    options.lockAtMostFor ?? runtime.defaultLockAtMostFor,
    options.lockAtLeastFor ?? runtime.defaultLockAtLeastFor,
  );
  const result = await runtime.executor.executeWithLock(task, config);
  return result.wasExecuted ? result.getResult() : undefined;
}

function rememberSchedulerLockOptions(handler: object, options: SchedulerLockOptions): void {
  optionsByHandler.set(handler, options);
  metadataReflect().defineMetadata?.(SCHEDULER_LOCK_METADATA, options, handler);
}

function validateSchedulerLockOptions(options: SchedulerLockOptions): void {
  if (options === null || typeof options !== 'object') {
    throw new LockException('@SchedulerLock options are required');
  }
  if (typeof options.name !== 'string' || options.name.length === 0) {
    throw new LockException('@SchedulerLock name must be a non-empty string');
  }
  Utils.validateLockName(options.name);
  const most = options.lockAtMostFor === undefined ? undefined : parseDuration(options.lockAtMostFor);
  const least = options.lockAtLeastFor === undefined ? undefined : parseDuration(options.lockAtLeastFor);
  if (most !== undefined && least !== undefined && least > most) {
    throw new LockException('lockAtLeastFor must be <= lockAtMostFor');
  }
}

function isSchedulerLockOptions(value: unknown): value is SchedulerLockOptions {
  if (value === null || typeof value !== 'object') return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0;
}

function copyFunctionMetadata(from: object, to: object): void {
  const reflect = metadataReflect();
  if (typeof reflect.getMetadataKeys !== 'function' || typeof reflect.defineMetadata !== 'function') return;
  for (const key of reflect.getMetadataKeys(from)) {
    reflect.defineMetadata(key, reflect.getMetadata?.(key, from), to);
  }
}

function metadataReflect(): MetadataReflect {
  return Reflect as MetadataReflect;
}
