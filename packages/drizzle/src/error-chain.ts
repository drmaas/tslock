export function errorChain(e: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<object>();
  let current: unknown = e;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) break;
    if (seen.has(current)) break;
    seen.add(current);
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}
