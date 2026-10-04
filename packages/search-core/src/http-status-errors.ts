export function isConflictError(e: unknown): boolean {
  const err = e as { meta?: { statusCode?: number }; statusCode?: number };
  return err?.meta?.statusCode === 409 || err?.statusCode === 409;
}

export function isNotFoundError(e: unknown): boolean {
  const err = e as { meta?: { statusCode?: number }; statusCode?: number };
  return err?.meta?.statusCode === 404 || err?.statusCode === 404;
}
