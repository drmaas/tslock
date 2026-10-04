export const LOCK_SCRIPT = `
if (ctx._source[params.lockUntilField] <= params.now) {
  ctx._source[params.lockUntilField] = params.lockUntil;
  ctx._source[params.lockedAtField] = params.lockedAt;
  ctx._source[params.lockedByField] = params.lockedBy;
} else {
  ctx.op = 'none';
}
`;

export const UNLOCK_SCRIPT = 'ctx._source[params.lockUntilField] = params.unlockTime';

export const EXTEND_SCRIPT = `
if (ctx._source[params.lockedByField] == params.lockedBy && ctx._source[params.lockUntilField] > params.now) {
  ctx._source[params.lockUntilField] = params.lockUntil;
} else {
  ctx.op = 'none';
}
`;
