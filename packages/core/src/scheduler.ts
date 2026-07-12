export interface Disposable {
  clear(): void;
}

export interface Scheduler {
  setInterval(callback: () => void, ms: number): Disposable;
}

export class DefaultScheduler implements Scheduler {
  setInterval(callback: () => void, ms: number): Disposable {
    const handle = setInterval(callback, ms);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
    return {
      clear: () => clearInterval(handle),
    };
  }
}
