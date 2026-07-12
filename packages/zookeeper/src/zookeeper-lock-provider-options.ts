export const DEFAULT_PATH = '/shedlock';

export interface ZooKeeperLockProviderOptions {
  basePath?: string;
}

function normalizePath(path: string): string {
  let result = path;
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  if (!result.startsWith('/')) {
    result = '/' + result;
  }
  return result;
}

export function resolveOptions(options?: ZooKeeperLockProviderOptions): { basePath: string } {
  return { basePath: normalizePath(options?.basePath ?? DEFAULT_PATH) };
}
