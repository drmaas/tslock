import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseProduct, SqlConfiguration, createSqlStatementsSource } from '@tslock/sql-support';
import { fuzzTests, storageBasedLockProviderIntegrationTests } from '@tslock/test-support';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { getDialectInfo } from '../../src/dialect-info.js';
import { KyselyLockProvider } from '../../src/kysely-lock-provider.js';
import { KyselyStorageAccessor } from '../../src/kysely-storage-accessor.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
let pool: Pool | undefined;
let db: Kysely<unknown> | undefined;
let provider: KyselyLockProvider | undefined;
let accessor: KyselyStorageAccessor | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tslock_test')
    .withUsername('tslock')
    .withPassword('tslock')
    .start();

  try {
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shedlock (
        name VARCHAR(255) PRIMARY KEY,
        lockUntil TIMESTAMP NOT NULL,
        lockedAt TIMESTAMP NOT NULL,
        lockedBy VARCHAR(255) NOT NULL
      )
    `);
    const configuration = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    provider = new KyselyLockProvider(db, 'postgresql', configuration);
    accessor = new KyselyStorageAccessor(db, createSqlStatementsSource(configuration), getDialectInfo('postgresql'));
  } catch (error) {
    await db?.destroy().catch(() => undefined);
    if (!db) await pool?.end().catch(() => undefined);
    await container.stop().catch(() => undefined);
    db = undefined;
    pool = undefined;
    container = undefined;
    throw error;
  }
}, 120_000);

const getProvider = async () => {
  if (!provider) throw new Error('Kysely integration provider was not initialized');
  return provider;
};

const getAccessor = async () => {
  if (!accessor) throw new Error('Kysely integration accessor was not initialized');
  return accessor;
};

storageBasedLockProviderIntegrationTests(getProvider, { getAccessor });
fuzzTests(getProvider);

afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    if (!db) await pool?.end();
    await container?.stop();
  }
});
