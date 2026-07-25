export type LockNameStrategy = (method: string, path: string) => string;

export function methodPathStrategy(method: string, path: string): string {
  return `${method.toUpperCase()}:${path}`;
}

export function deriveLockName(
  strategy: LockNameStrategy,
  prefix: string,
  method: string,
  path: string,
  overrideName?: string,
): string {
  if (overrideName) {
    return overrideName;
  }
  const base = strategy(method, path);
  if (prefix) {
    return `${prefix}:${base}`;
  }
  return base;
}
