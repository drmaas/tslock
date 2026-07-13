export interface ResolvedOptions {
  label: string;
  nameCol: string;
  lockUntilCol: string;
  lockedAtCol: string;
  lockedByCol: string;
}

function q(name: string): string {
  return `\`${name}\``;
}

export function buildInsertCypher(o: ResolvedOptions): string {
  return (
    `CREATE (lock:${q(o.label)} {` +
    `${q(o.nameCol)}: $name, ` +
    `${q(o.lockUntilCol)}: $lockUntil, ` +
    `${q(o.lockedAtCol)}: $lockedAt, ` +
    `${q(o.lockedByCol)}: $lockedBy` +
    `})`
  );
}

export function buildUpdateCypher(o: ResolvedOptions): string {
  return (
    `MATCH (lock:${q(o.label)} {${q(o.nameCol)}: $name}) ` +
    `WHERE lock.${q(o.lockUntilCol)} <= $now ` +
    `SET lock.${q(o.lockUntilCol)} = $lockUntil, ` +
    `lock.${q(o.lockedAtCol)} = $lockedAt, ` +
    `lock.${q(o.lockedByCol)} = $lockedBy ` +
    `RETURN lock`
  );
}

export function buildUnlockCypher(o: ResolvedOptions): string {
  return `MATCH (lock:${q(o.label)} {${q(o.nameCol)}: $name}) ` + `SET lock.${q(o.lockUntilCol)} = $unlockTime`;
}

export function buildExtendCypher(o: ResolvedOptions): string {
  return (
    `MATCH (lock:${q(o.label)} {${q(o.nameCol)}: $name}) ` +
    `WHERE lock.${q(o.lockedByCol)} = $lockedBy ` +
    `AND lock.${q(o.lockUntilCol)} > $now ` +
    `SET lock.${q(o.lockUntilCol)} = $lockUntil ` +
    `RETURN lock`
  );
}

export function buildCreateConstraintCypher(o: ResolvedOptions): string {
  return (
    `CREATE CONSTRAINT shedlock_name_unique IF NOT EXISTS ` +
    `FOR (lock:${q(o.label)}) ` +
    `REQUIRE lock.${q(o.nameCol)} IS UNIQUE`
  );
}
