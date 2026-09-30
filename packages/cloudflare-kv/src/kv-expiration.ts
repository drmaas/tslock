export const CLOUDFLARE_KV_MIN_EXPIRATION_TTL_SECONDS = 60;

export function kvExpirationTtlSeconds(lockUntilMs: number, nowMs: number): number {
  const remainingMs = Math.max(0, lockUntilMs - nowMs);
  return Math.max(CLOUDFLARE_KV_MIN_EXPIRATION_TTL_SECONDS, Math.floor(remainingMs / 1000) + 1);
}
