import {
  type ExtensibleLockProvider,
  type LockConfiguration,
  type SimpleLock,
  StorageBasedLockProvider,
  Utils,
} from '@tslock/core';
import type cassandra from 'cassandra-driver';
import type { ResolvedCassandraOptions, ResolvedColumnNames } from './cassandra-cql.js';
import { CassandraStorageAccessor } from './cassandra-storage-accessor.js';
import { validateIdentifier, validateSerialConsistency } from './validation.js';

export interface CassandraColumnNames {
  readonly name: string;
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}

export interface CassandraLockProviderOptions {
  readonly keyspace: string;
  readonly tableName?: string;
  readonly columnNames?: Partial<CassandraColumnNames>;
  readonly lockedByValue?: string;
  readonly consistencyLevel?: number;
  readonly serialConsistencyLevel?: number;
}

const DEFAULT_TABLE_NAME = 'shedlock';

const DEFAULT_COLUMN_NAMES: CassandraColumnNames = {
  name: 'name',
  lockUntil: 'lock_until',
  lockedAt: 'locked_at',
  lockedBy: 'locked_by',
};

const DEFAULT_CONSISTENCY = 6;
const DEFAULT_SERIAL_CONSISTENCY = 9;

function resolveOptions(options: CassandraLockProviderOptions): ResolvedCassandraOptions {
  validateIdentifier(options.keyspace, 'keyspace');

  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  validateIdentifier(tableName, 'tableName');

  const columnNames: ResolvedColumnNames = { ...DEFAULT_COLUMN_NAMES, ...options.columnNames };
  validateIdentifier(columnNames.name, 'columnNames.name');
  validateIdentifier(columnNames.lockUntil, 'columnNames.lockUntil');
  validateIdentifier(columnNames.lockedAt, 'columnNames.lockedAt');
  validateIdentifier(columnNames.lockedBy, 'columnNames.lockedBy');

  const serialConsistencyLevel = options.serialConsistencyLevel ?? DEFAULT_SERIAL_CONSISTENCY;
  validateSerialConsistency(serialConsistencyLevel);

  const consistencyLevel = options.consistencyLevel ?? DEFAULT_CONSISTENCY;
  const lockedByValue = options.lockedByValue ?? Utils.getHostname();

  return {
    keyspace: options.keyspace,
    tableName,
    columnNames,
    lockedByValue,
    consistencyLevel,
    serialConsistencyLevel,
  };
}

export class CassandraLockProvider implements ExtensibleLockProvider {
  private readonly delegate: StorageBasedLockProvider;

  constructor(client: cassandra.Client, options: CassandraLockProviderOptions) {
    const opts = resolveOptions(options);
    this.delegate = new StorageBasedLockProvider(new CassandraStorageAccessor(client, opts));
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.delegate.lock(config);
  }

  clearCache(name: string): void {
    this.delegate.clearCache(name);
  }
}

export async function createLockTable(
  client: cassandra.Client,
  options: { keyspace: string; tableName?: string; columnNames?: Partial<CassandraColumnNames> },
): Promise<void> {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  const columnNames: ResolvedColumnNames = { ...DEFAULT_COLUMN_NAMES, ...options.columnNames };
  validateIdentifier(options.keyspace, 'keyspace');
  validateIdentifier(tableName, 'tableName');
  validateIdentifier(columnNames.name, 'columnNames.name');
  validateIdentifier(columnNames.lockUntil, 'columnNames.lockUntil');
  validateIdentifier(columnNames.lockedAt, 'columnNames.lockedAt');
  validateIdentifier(columnNames.lockedBy, 'columnNames.lockedBy');

  const cql = `CREATE TABLE IF NOT EXISTS ${options.keyspace}.${tableName} (${columnNames.name} text PRIMARY KEY, ${columnNames.lockUntil} timestamp, ${columnNames.lockedAt} timestamp, ${columnNames.lockedBy} text)`;
  await client.execute(cql);
}
