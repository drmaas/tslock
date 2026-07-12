import { ClockProvider, Utils, lockAtMostUntil, unlockTime } from '@tslock/core';
import type { LockConfiguration, SimpleLock } from '@tslock/core';
import ZooKeeper from 'zookeeper';
import { ZooKeeperLock } from './zookeeper-lock.js';
import { isBadVersionException, isNodeExistsException, isNoNodeException } from './zookeeper-errors.js';

const ZOO_PERSISTENT = 0;

export class ZooKeeperAccessor {
  private basePathEnsured = false;

  constructor(
    private readonly client: InstanceType<typeof ZooKeeper>,
    private readonly basePath: string,
  ) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const lockAtMostUntilValue = lockAtMostUntil(config);
    const isoLockAtMostUntil = Utils.toIsoString(lockAtMostUntilValue);
    const nodePath = `${this.basePath}/${config.name}`;

    try {
      const [stat, data] = await this.client.get(nodePath, false);
      const dataStr = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const existingLockUntil = Date.parse(dataStr);

      if (existingLockUntil > now) {
        return undefined;
      }

      await this.client.set(nodePath, Buffer.from(isoLockAtMostUntil), stat.version);
      return new ZooKeeperLock(this, config);
    } catch (e) {
      if (isNoNodeException(e)) {
        await this.ensureBasePath();
        try {
          await this.client.create(nodePath, Buffer.from(isoLockAtMostUntil), ZOO_PERSISTENT);
          return new ZooKeeperLock(this, config);
        } catch (e2) {
          if (isNodeExistsException(e2)) return undefined;
          throw e2;
        }
      }
      if (isBadVersionException(e)) return undefined;
      throw e;
    }
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const isoUnlock = Utils.toIsoString(unlockTime(config));
    const nodePath = `${this.basePath}/${config.name}`;
    await this.client.set(nodePath, Buffer.from(isoUnlock), -1);
  }

  private async ensureBasePath(): Promise<void> {
    if (this.basePathEnsured) return;
    await new Promise<void>((resolve, reject) => {
      this.client.mkdirp(this.basePath, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.basePathEnsured = true;
  }
}
