import { ClockProvider, type LockConfiguration, Utils } from '@tslock/core';
import type { Etcd3, Lease } from 'etcd3';
import { MILLIS_IN_SECOND } from './etcd-lock-provider-options.js';
import { EtcdLock } from './etcd-lock.js';

export class EtcdAccessor {
  constructor(
    private readonly client: Etcd3,
    private readonly env: string,
  ) {}

  async lock(config: LockConfiguration): Promise<EtcdLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const key = `shedlock:${this.env}:${config.name}`;
    const value = `ADDED:${Utils.toIsoString(now)}@${hostname}`;
    const ttlSeconds = Math.ceil(config.lockAtMostFor / MILLIS_IN_SECOND);

    const lease = this.client.lease(ttlSeconds);

    try {
      const result = await this.client
        .if(key, 'Version', '==', 0)
        .then(this.client.put(key).value(value).lease(lease.grant()))
        .else(this.client.get(key))
        .commit();

      if (result.succeeded) {
        return new EtcdLock(config, this, lease);
      }

      await lease.revoke();
      return undefined;
    } catch (e) {
      try {
        await lease.revoke();
      } catch {}
      throw e;
    }
  }

  async unlock(config: LockConfiguration, lease: Lease): Promise<void> {
    const key = `shedlock:${this.env}:${config.name}`;

    if (config.lockAtLeastFor <= 0) {
      await lease.revoke();
      return;
    }

    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const value = `ADDED:${Utils.toIsoString(now)}@${hostname}`;
    const newTtlSeconds = Math.ceil(config.lockAtLeastFor / MILLIS_IN_SECOND);

    const newLease = this.client.lease(newTtlSeconds);
    await this.client.put(key).value(value).lease(newLease.grant()).exec();
    await lease.revoke();
  }
}
