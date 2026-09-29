import { ClockProvider } from '@tslock/core';

export class MutableClock {
  private current: number;

  constructor(initialMs: number) {
    this.current = Math.trunc(initialMs);
  }

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = Math.trunc(ms);
  }

  advance(ms: number): void {
    this.current += Math.trunc(ms);
  }

  install(): void {
    ClockProvider.setClock(() => this.current);
  }
}

export async function withMutableClock<T>(initialMs: number, fn: (clock: MutableClock) => Promise<T> | T): Promise<T> {
  const clock = new MutableClock(initialMs);
  clock.install();
  try {
    return await fn(clock);
  } finally {
    ClockProvider.resetClock();
  }
}
