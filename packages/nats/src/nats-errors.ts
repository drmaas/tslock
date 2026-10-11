export function isNatsConflictError(e: unknown): boolean {
  if (e && typeof e === 'object') {
    const err = e as {
      code?: number | string;
      message?: string;
      api_error?: { err_code?: number };
    };
    if (err.code === 10071 || err.api_error?.err_code === 10071) return true;
    if (err.message?.includes('stream name already in use') || err.message?.includes('wrong last sequence')) {
      return true;
    }
  }
  return false;
}
