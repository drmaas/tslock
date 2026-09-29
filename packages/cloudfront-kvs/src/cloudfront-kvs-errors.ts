function getErrorName(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    return (e as Record<string, unknown>).name as string | undefined;
  }
  return undefined;
}

function getStatusCode(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    return ((e as Record<string, unknown>).$metadata as Record<string, unknown> | undefined)?.httpStatusCode as
      | number
      | undefined;
  }
  return undefined;
}

export function isConflict(e: unknown): boolean {
  const name = getErrorName(e);
  if (name === 'ConflictException' || name === 'Conflict') return true;
  return getStatusCode(e) === 409;
}

export function isNotFound(e: unknown): boolean {
  const name = getErrorName(e);
  if (name === 'ResourceNotFoundException' || name === 'NotFound') return true;
  return getStatusCode(e) === 404;
}
