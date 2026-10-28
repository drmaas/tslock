function matchesResultCode(e: unknown, code: number): boolean {
  if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code) {
    return true;
  }
  if (!(e instanceof Error)) return false;
  const [token] = e.message.split(/\s/, 1);
  return token === String(code);
}

export function isNoNodeException(e: unknown): boolean {
  return matchesResultCode(e, -101);
}

export function isBadVersionException(e: unknown): boolean {
  return matchesResultCode(e, -103);
}

export function isNodeExistsException(e: unknown): boolean {
  return matchesResultCode(e, -110);
}
