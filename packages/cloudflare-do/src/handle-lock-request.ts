import type { DoLockStorage } from './do-lock-storage.js';
import { storageKeyForLock } from './do-lock-storage.js';
import type { DoLockRecord, LockOp, LockOpResult } from './protocol.js';

function durationsAreValid(lockAtMostFor: number, lockAtLeastFor: number): boolean {
  return (
    Number.isFinite(lockAtMostFor) &&
    Number.isFinite(lockAtLeastFor) &&
    lockAtMostFor >= 0 &&
    lockAtLeastFor >= 0 &&
    lockAtLeastFor <= lockAtMostFor
  );
}

function storedLeastUntil(existing: DoLockRecord, now: number): number {
  const stored = existing.lockAtLeastUntil;
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : now;
}

function owns(existing: DoLockRecord, token: string): existing is DoLockRecord & { token: string } {
  return (
    token.length > 0 && typeof existing.token === 'string' && existing.token.length > 0 && existing.token === token
  );
}

export async function applyLockOp(
  storage: DoLockStorage,
  body: LockOp,
  now: number = Date.now(),
): Promise<LockOpResult> {
  const key = storageKeyForLock(body.name);

  if (body.op === 'lock') {
    if (body.token.length === 0) {
      return { ok: false, reason: 'not_owner' };
    }
    const existing = await storage.get(key);
    if (existing && existing.lockUntil > now) {
      return { ok: false, reason: 'held' };
    }
    await storage.put(key, {
      lockUntil: now + body.lockAtMostFor,
      lockAtLeastUntil: now + body.lockAtLeastFor,
      lockedAt: now,
      lockedBy: body.lockedBy,
      token: body.token,
    });
    return { ok: true, acquired: true, token: body.token };
  }

  if (body.op === 'unlock') {
    const existing = await storage.get(key);
    if (!existing || !owns(existing, body.token)) {
      return { ok: true };
    }
    const next: DoLockRecord = {
      lockUntil: Math.max(now, storedLeastUntil(existing, now)),
      lockedAt: existing.lockedAt,
      lockedBy: existing.lockedBy,
      token: existing.token,
    };
    if (typeof existing.lockAtLeastUntil === 'number' && Number.isFinite(existing.lockAtLeastUntil)) {
      next.lockAtLeastUntil = existing.lockAtLeastUntil;
    }
    await storage.put(key, next);
    return { ok: true };
  }

  const existing = await storage.get(key);
  if (!existing) {
    return { ok: false, reason: 'missing' };
  }
  if (!owns(existing, body.token)) {
    return { ok: false, reason: 'not_owner' };
  }
  if (existing.lockUntil <= now) {
    return { ok: false, reason: 'expired' };
  }
  await storage.put(key, {
    lockUntil: now + body.lockAtMostFor,
    lockAtLeastUntil: Math.max(storedLeastUntil(existing, now), now, now + body.lockAtLeastFor),
    lockedAt: existing.lockedAt,
    lockedBy: existing.lockedBy,
    token: existing.token,
  });
  return { ok: true, extended: true };
}

export async function handleTslockLockRequest(
  storage: DoLockStorage,
  request: Request,
  now: number = Date.now(),
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !('op' in body) || !('name' in body)) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }
  const op = body as LockOp;
  if (
    typeof op.name !== 'string' ||
    typeof op.lockAtMostFor !== 'number' ||
    typeof op.lockAtLeastFor !== 'number' ||
    typeof op.createdAt !== 'number' ||
    typeof op.lockedBy !== 'string' ||
    typeof op.token !== 'string' ||
    op.token.length === 0 ||
    (op.op !== 'lock' && op.op !== 'unlock' && op.op !== 'extend')
  ) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }
  if (!durationsAreValid(op.lockAtMostFor, op.lockAtLeastFor)) {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }
  const result = await applyLockOp(storage, op, now);
  return Response.json(result, { status: 200 });
}
