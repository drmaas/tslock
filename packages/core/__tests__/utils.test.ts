import { describe, expect, it, vi } from 'vitest';
import { LockException } from '../src/lock-exception.js';
import { Utils } from '../src/utils.js';

describe('Utils.getHostname', () => {
  it('memoizes the hostname after the first successful call', async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('node:os', () => ({
      hostname: () => {
        calls.push('hostname');
        return 'test-host';
      },
    }));
    const { Utils: FreshUtils } = await import('../src/utils.js');
    expect(FreshUtils.getHostname()).toBe('test-host');
    expect(FreshUtils.getHostname()).toBe('test-host');
    expect(FreshUtils.getHostname()).toBe('test-host');
    expect(calls).toHaveLength(1);
  });

  it('falls back to unknown when hostname() throws, without caching the failure', async () => {
    vi.resetModules();
    let throwing = true;
    vi.doMock('node:os', () => ({
      hostname: () => {
        if (throwing) throw new Error('hostname unavailable');
        return 'recovered-host';
      },
    }));
    const { Utils: FreshUtils } = await import('../src/utils.js');
    expect(FreshUtils.getHostname()).toBe('unknown');
    throwing = false;
    expect(FreshUtils.getHostname()).toBe('recovered-host');
  });
});

describe('Utils.toTtlSeconds', () => {
  it('never expires early: rounds up to whole seconds', () => {
    expect(Utils.toTtlSeconds(0)).toBe(1);
    expect(Utils.toTtlSeconds(999)).toBe(1);
    expect(Utils.toTtlSeconds(1000)).toBe(2);
    expect(Utils.toTtlSeconds(1500)).toBe(2);
    expect(Utils.toTtlSeconds(60_000)).toBe(61);
  });
});

describe('Utils.validateLockName', () => {
  it('accepts a normal lock name', () => {
    expect(() => Utils.validateLockName('my-task')).not.toThrow();
  });

  it('rejects control characters', () => {
    expect(() => Utils.validateLockName('bad\nname')).toThrow(LockException);
    expect(() => Utils.validateLockName('bad\u0000name')).toThrow(LockException);
    expect(() => Utils.validateLockName('bad\u001fname')).toThrow(LockException);
  });

  it('rejects format characters (Cf)', () => {
    expect(() => Utils.validateLockName('bad\u200ename')).toThrow(LockException);
  });

  it('accepts names up to 1024 UTF-8 bytes and rejects longer ones', () => {
    expect(() => Utils.validateLockName('a'.repeat(1024))).not.toThrow();
    expect(() => Utils.validateLockName('a'.repeat(1025))).toThrow(LockException);
    expect(() => Utils.validateLockName('é'.repeat(512))).not.toThrow();
    expect(() => Utils.validateLockName('é'.repeat(513))).toThrow(LockException);
  });
});
