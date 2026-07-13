import {
  type ExtensibleLockProvider,
  type LockConfiguration,
  type SimpleLock,
  StorageBasedLockProvider,
} from '@tslock/core';
import type { ResolvedOptions } from './neo4j-cypher.js';
import { Neo4jStorageAccessor } from './neo4j-storage-accessor.js';

export interface Neo4jColumnNames {
  readonly name: string;
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}

export interface Neo4jLockProviderOptions {
  readonly label?: string;
  readonly columnNames?: Partial<Neo4jColumnNames>;
  readonly lockedByValue?: string;
  readonly database?: string;
}

const DEFAULT_LABEL = 'ShedLock';

const DEFAULT_COLUMN_NAMES: Neo4jColumnNames = {
  name: 'name',
  lockUntil: 'lockUntil',
  lockedAt: 'lockedAt',
  lockedBy: 'lockedBy',
};

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateIdentifier(name: string, field: string): void {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new Error(`${field} "${name}" is not a valid Neo4j identifier`);
  }
}

export function resolveOptions(options?: Neo4jLockProviderOptions): ResolvedOptions {
  const label = options?.label ?? DEFAULT_LABEL;
  validateIdentifier(label, 'label');
  const columnNames = options?.columnNames ?? {};
  const nameCol = columnNames.name ?? DEFAULT_COLUMN_NAMES.name;
  const lockUntilCol = columnNames.lockUntil ?? DEFAULT_COLUMN_NAMES.lockUntil;
  const lockedAtCol = columnNames.lockedAt ?? DEFAULT_COLUMN_NAMES.lockedAt;
  const lockedByCol = columnNames.lockedBy ?? DEFAULT_COLUMN_NAMES.lockedBy;
  validateIdentifier(nameCol, 'columnNames.name');
  validateIdentifier(lockUntilCol, 'columnNames.lockUntil');
  validateIdentifier(lockedAtCol, 'columnNames.lockedAt');
  validateIdentifier(lockedByCol, 'columnNames.lockedBy');
  return { label, nameCol, lockUntilCol, lockedAtCol, lockedByCol };
}

export class Neo4jLockProvider implements ExtensibleLockProvider {
  private readonly delegate: StorageBasedLockProvider;

  constructor(driver: import('neo4j-driver').Driver, options?: Neo4jLockProviderOptions) {
    const resolved = resolveOptions(options);
    this.delegate = new StorageBasedLockProvider(
      new Neo4jStorageAccessor(driver, resolved, options?.lockedByValue, options?.database),
    );
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.delegate.lock(config);
  }

  clearCache(name: string): void {
    this.delegate.clearCache(name);
  }
}
