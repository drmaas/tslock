export function isNoNodeException(e: unknown): boolean {
  return (e as { code?: number })?.code === -101;
}

export function isBadVersionException(e: unknown): boolean {
  return (e as { code?: number })?.code === -103;
}

export function isNodeExistsException(e: unknown): boolean {
  return (e as { code?: number })?.code === -110;
}
