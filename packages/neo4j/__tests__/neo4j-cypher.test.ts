import { describe, expect, it } from 'vitest';
import {
  buildCreateConstraintCypher,
  buildExtendCypher,
  buildInsertCypher,
  buildProbeLockExpiryCypher,
  buildUnlockCypher,
  buildUpdateCypher,
  type ResolvedOptions,
} from '../src/neo4j-cypher.js';

const defaultOpts: ResolvedOptions = {
  label: 'ShedLock',
  nameCol: 'name',
  lockUntilCol: 'lockUntil',
  lockedAtCol: 'lockedAt',
  lockedByCol: 'lockedBy',
};

describe('buildInsertCypher', () => {
  it('builds default insert cypher', () => {
    expect(buildInsertCypher(defaultOpts)).toBe(
      'CREATE (lock:`ShedLock` {`name`: $name, `lockUntil`: $lockUntil, `lockedAt`: $lockedAt, `lockedBy`: $lockedBy})',
    );
  });

  it('uses custom label and column names', () => {
    const opts: ResolvedOptions = {
      label: 'MyLock',
      nameCol: 'id',
      lockUntilCol: 'expires',
      lockedAtCol: 'created',
      lockedByCol: 'owner',
    };
    expect(buildInsertCypher(opts)).toContain(':`MyLock` {`id`: $name, `expires`: $lockUntil');
  });
});

describe('buildProbeLockExpiryCypher', () => {
  it('builds probe cypher without SET', () => {
    const result = buildProbeLockExpiryCypher(defaultOpts);
    expect(result).toContain('MATCH (lock:`ShedLock` {`name`: $name})');
    expect(result).toContain('lock.`lockUntil` <= $now AS expired');
    expect(result).not.toContain('SET');
  });
});

describe('buildUpdateCypher', () => {
  it('builds default update cypher', () => {
    const result = buildUpdateCypher(defaultOpts);
    expect(result).toContain('WHERE lock.`lockUntil` <= $now');
    expect(result).toContain('RETURN lock');
    expect(result).toContain('SET lock.`lockUntil` = $lockUntil');
  });
});

describe('buildUnlockCypher', () => {
  it('builds unlock cypher without RETURN', () => {
    const result = buildUnlockCypher(defaultOpts);
    expect(result).toContain('WHERE lock.`lockedBy` = $lockedBy');
    expect(result).toContain('AND lock.`lockUntil` = $expectedLockUntil');
    expect(result).toContain('SET lock.`lockUntil` = $unlockTime');
    expect(result).not.toContain('RETURN');
  });

  it('uses the configured lockUntil property', () => {
    const result = buildUnlockCypher({ ...defaultOpts, lockUntilCol: 'expires', lockedByCol: 'owner' });
    expect(result).toContain('lock.`owner` = $lockedBy');
    expect(result).toContain('lock.`expires` = $expectedLockUntil');
  });
});

describe('buildExtendCypher', () => {
  it('builds extend cypher with ownership check', () => {
    const result = buildExtendCypher(defaultOpts);
    expect(result).toContain('WHERE lock.`lockedBy` = $lockedBy');
    expect(result).toContain('AND lock.`lockUntil` = $expectedLockUntil');
    expect(result).toContain('AND lock.`lockUntil` > $now');
    expect(result).toContain('RETURN lock');
  });

  it('uses the configured lockUntil property', () => {
    const result = buildExtendCypher({ ...defaultOpts, lockUntilCol: 'expires', lockedByCol: 'owner' });
    expect(result).toContain('lock.`owner` = $lockedBy');
    expect(result).toContain('lock.`expires` = $expectedLockUntil');
    expect(result).toContain('lock.`expires` > $now');
  });
});

describe('buildCreateConstraintCypher', () => {
  it('builds default constraint cypher', () => {
    expect(buildCreateConstraintCypher(defaultOpts)).toBe(
      'CREATE CONSTRAINT shedlock_name_unique IF NOT EXISTS FOR (lock:`ShedLock`) REQUIRE lock.`name` IS UNIQUE',
    );
  });

  it('uses custom label', () => {
    const opts: ResolvedOptions = { ...defaultOpts, label: 'MyLock' };
    expect(buildCreateConstraintCypher(opts)).toContain('(lock:`MyLock`)');
  });
});
