import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DatabaseProduct, SqlConfiguration, createSqlStatementsSource } from '@tslock/sql-support';
import { fuzzTests, storageBasedLockProviderIntegrationTests } from '@tslock/test-support';
import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { PgConnection } from '../../src/connections/pg-connection.js';
import { SqlLockProvider } from '../../src/sql-lock-provider.js';
import { SqlStorageAccessor } from '../../src/sql-storage-accessor.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
let pool: Pool | undefined;
let provider: SqlLockProvider | undefined;
let accessor: SqlStorageAccessor | undefined;

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
    const connection = new PgConnection(pool);
    const configuration = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
    const statementsSource = createSqlStatementsSource(configuration);
    provider = new SqlLockProvider(connection, configuration);
    accessor = new SqlStorageAccessor(connection, statementsSource);
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await container.stop().catch(() => undefined);
    pool = undefined;
    container = undefined;
    throw error;
  }
}, 120_000);

const getProvider = async () => {
  if (!provider) throw new Error('PostgreSQL integration provider was not initialized');
  return provider;
};

const getAccessor = async () => {
  if (!accessor) throw new Error('PostgreSQL integration accessor was not initialized');
  return accessor;
};

storageBasedLockProviderIntegrationTests(getProvider, { getAccessor });
fuzzTests(getProvider);

afterAll(async () => {
  try {
    await pool?.end();
  } finally {
    await container?.stop();
  }
});
