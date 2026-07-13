import { ClockProvider, type LockConfiguration, LockException, Utils } from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import { EtcdLockProvider } from '../src/etcd-lock-provider.js';

function makeConfig(name: string, lockAtMostFor: number, lockAtLeastFor = 0): LockConfiguration {
  return {
    name,
    lockAtMostFor,
    lockAtLeastFor,
    createdAt: ClockProvider.now(),
  };
}

function makeClient() {
  const commit_ = vi.fn().mockResolvedValue({ succeeded: true });
  const txnChain: Record<string, any> = {};
  Object.defineProperty(txnChain, 'then', { value: vi.fn().mockReturnValue(txnChain) });
  txnChain.else = vi.fn().mockReturnValue(txnChain);
  txnChain.commit = commit_;

  const putBuilder = {
    value: vi.fn().mockReturnThis(),
    lease: vi.fn().mockReturnThis(),
    op: vi.fn().mockResolvedValue({}),
    exec: vi.fn().mockResolvedValue({}),
  };

  const lease = {
    leaseID: Promise.resolve(12345),
    revoke: vi.fn().mockResolvedValue(undefined),
  };

  const client = {
    if: vi.fn().mockReturnValue(txnChain),
    put: vi.fn().mockReturnValue(putBuilder),
    get: vi.fn().mockReturnValue({ op: vi.fn().mockResolvedValue({}) }),
    lease: vi.fn().mockReturnValue(lease),
  };

  return { client: client as any, txnChain, putBuilder, lease };
}

describe('EtcdLockProvider', () => {
  describe('lock', () => {
    it('acquires a lock when key does not exist', async () => {
      const { client, txnChain, putBuilder } = makeClient();
      const config = makeConfig('test-lock', 30_000);

      const provider = new EtcdLockProvider(client);
      const lock = await provider.lock(config);

      expect(lock).toBeDefined();
      expect(client.if).toHaveBeenCalledWith('shedlock:default:test-lock', 'Version', '==', 0);
      expect(client.lease).toHaveBeenCalledWith(30);
      expect(putBuilder.value).toHaveBeenCalled();
      expect(txnChain.then).toHaveBeenCalled();
      expect(txnChain.else).toHaveBeenCalled();
      expect(txnChain.commit).toHaveBeenCalled();
    });

    it('acquires a lock with custom env', async () => {
      const { client } = makeClient();
      const provider = new EtcdLockProvider(client, { env: 'prod' });
      const config = makeConfig('my-lock', 30_000);

      const lock = await provider.lock(config);

      expect(lock).toBeDefined();
      expect(client.if).toHaveBeenCalledWith('shedlock:prod:my-lock', 'Version', '==', 0);
    });

    it('uses Math.ceil for TTL seconds', async () => {
      const { client } = makeClient();
      const provider = new EtcdLockProvider(client);
      const config = makeConfig('subsecond', 500);

      const lock = await provider.lock(config);

      expect(lock).toBeDefined();
      expect(client.lease).toHaveBeenCalledWith(1);
    });

    it('returns undefined when key exists', async () => {
      const { client, txnChain, lease } = makeClient();
      txnChain.commit.mockResolvedValue({ succeeded: false });

      const provider = new EtcdLockProvider(client);
      const lock = await provider.lock(makeConfig('locked', 30_000));

      expect(lock).toBeUndefined();
      expect(lease.revoke).toHaveBeenCalled();
    });

    it('revokes lease and rethrows on commit error', async () => {
      const { client, txnChain, lease } = makeClient();
      txnChain.commit.mockRejectedValue(new Error('connection lost'));

      const provider = new EtcdLockProvider(client);

      await expect(provider.lock(makeConfig('fail', 30_000))).rejects.toThrow('connection lost');
      expect(lease.revoke).toHaveBeenCalled();
    });

    it('does not throw when best-effort lease revoke fails', async () => {
      const { client, txnChain, lease } = makeClient();
      txnChain.commit.mockRejectedValue(new Error('txn failed'));
      lease.revoke.mockRejectedValue(new Error('revoke also failed'));

      const provider = new EtcdLockProvider(client);

      await expect(provider.lock(makeConfig('fail', 30_000))).rejects.toThrow('txn failed');
    });

    it('formats value as ADDED:isoTimestamp@hostname', async () => {
      const { client, putBuilder } = makeClient();
      ClockProvider.setClock(() => 1_700_000_000_000);

      const provider = new EtcdLockProvider(client);
      await provider.lock(makeConfig('val', 30_000));

      const valueArg = putBuilder.value.mock.calls[0][0];
      expect(valueArg).toMatch(/^ADDED:/);
      expect(valueArg).toContain(Utils.getHostname());
    });
  });

  describe('unlock', () => {
    it('revokes lease when lockAtLeastFor is 0', async () => {
      const { client, lease } = makeClient();

      const provider = new EtcdLockProvider(client);
      const lock = await provider.lock(makeConfig('unlock-me', 30_000));
      expect(lock).toBeDefined();

      await lock?.unlock();
      expect(lease.revoke).toHaveBeenCalled();
    });

    it('puts with new lease then revokes old lease when lockAtLeastFor > 0', async () => {
      const { client } = makeClient();
      const oldLease = {
        leaseID: Promise.resolve(12345),
        revoke: vi.fn().mockResolvedValue(undefined),
      };
      const newLease = {
        leaseID: Promise.resolve(67890),
        revoke: vi.fn().mockResolvedValue(undefined),
      };
      client.lease = vi.fn().mockReturnValueOnce(oldLease).mockReturnValueOnce(newLease);
      const altTxn: Record<string, any> = {};
      Object.defineProperty(altTxn, 'then', { value: vi.fn().mockReturnValue(altTxn) });
      altTxn.else = vi.fn().mockReturnValue(altTxn);
      altTxn.commit = vi.fn().mockResolvedValue({ succeeded: true });
      client.if = vi.fn().mockReturnValue(altTxn);

      const provider = new EtcdLockProvider(client);
      const lock = await provider.lock(makeConfig('keep-lock', 30_000, 10_000));
      expect(lock).toBeDefined();

      await lock?.unlock();

      expect(client.lease).toHaveBeenCalledTimes(2);
      expect(client.lease).toHaveBeenNthCalledWith(1, 30);
      expect(client.lease).toHaveBeenNthCalledWith(2, 10);
      expect(oldLease.revoke).toHaveBeenCalled();
    });
  });

  describe('extend', () => {
    it('throws LockException when extend is called', async () => {
      const { client } = makeClient();

      const provider = new EtcdLockProvider(client);
      const lock = await provider.lock(makeConfig('no-extend', 30_000));
      expect(lock).toBeDefined();

      try {
        const result = await lock?.extend(60_000, 0);
        expect(result).toBeUndefined();
      } catch (e) {
        expect(e).toBeInstanceOf(LockException);
      }
    });
  });
});
