function getCode(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    const code = obj.code ?? obj.status;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

export function isNotFound(e: unknown): boolean {
  return getCode(e) === 404;
}

export function isPreconditionFailed(e: unknown): boolean {
  return getCode(e) === 412;
}
