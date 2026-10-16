import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseProduct, SqlConfiguration } from '@tslock/sql-support';
import type { ConnectionPool } from 'mssql';
import type { Pool as MysqlPool } from 'mysql2/promise';
import type { Pool as PgPool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MssqlConnection } from '../src/connections/mssql-connection.js';
import { Mysql2Connection } from '../src/connections/mysql2-connection.js';
import { PgConnection } from '../src/connections/pg-connection.js';
import { SqlLockProvider } from '../src/sql-lock-provider.js';

const packageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const repoRoot = join(packageRoot, '..', '..');
const require = createRequire(join(packageRoot, 'package.json'));
const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
const directories: string[] = [];

function acceptsPg(pool: PgPool): SqlLockProvider {
  return new SqlLockProvider(
    new PgConnection(pool),
    new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }),
  );
}

function acceptsMysql(pool: MysqlPool): Promise<Mysql2Connection> {
  return Mysql2Connection.create(pool);
}

function acceptsMssql(pool: ConnectionPool): MssqlConnection {
  return new MssqlConnection(pool);
}

function resolvedPackage(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

function copyPublished(packageName: string, consumer: string): void {
  const source = join(repoRoot, 'packages', packageName.slice('@tslock/'.length));
  const destination = join(consumer, 'node_modules', ...packageName.split('/'));
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, 'package.json'), join(destination, 'package.json'));
  cpSync(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
}

function linkPackage(packageName: string, consumer: string): void {
  const destination = join(consumer, 'node_modules', ...packageName.split('/'));
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(resolvedPackage(packageName), destination);
}

function writeConsumer(files: Record<string, string>, links: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'tslock-sql-types-'));
  directories.push(directory);
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ private: true })}\n`);
  writeFileSync(
    join(directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          module: 'Node16',
          moduleResolution: 'Node16',
          target: 'ES2022',
          noEmit: true,
          types: ['node'],
        },
        files: Object.keys(files),
      },
      null,
      2,
    )}\n`,
  );
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  for (const packageName of ['@tslock/core', '@tslock/sql-support', '@tslock/sql']) {
    copyPublished(packageName, directory);
  }
  for (const packageName of ['@types/node', ...links]) {
    linkPackage(packageName, directory);
  }
  return directory;
}

function typecheck(directory: string): { status: number | null; output: string } {
  const result = spawnSync(tsc, ['-p', join(directory, 'tsconfig.json'), '--pretty', 'false'], {
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function declarationsBuilt(packageName: string): boolean {
  const dist = join(repoRoot, 'packages', packageName, 'dist');
  return existsSync(join(dist, 'index.d.ts')) && existsSync(join(dist, 'index.d.cts'));
}

describe('published @tslock/sql types', () => {
  beforeAll(() => {
    for (const packageName of ['core', 'sql-support', 'sql']) {
      if (declarationsBuilt(packageName)) continue;
      execFileSync('pnpm', ['--filter', `@tslock/${packageName}`, 'build'], { cwd: repoRoot, stdio: 'pipe' });
    }
  }, 120_000);

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps real driver pools assignable under strictFunctionTypes', () => {
    expect(acceptsPg).toBeTypeOf('function');
    expect(acceptsMysql).toBeTypeOf('function');
    expect(acceptsMssql).toBeTypeOf('function');
  });

  it('typechecks PgConnection and SqlLockProvider with only pg installed', () => {
    const source = `import { DatabaseProduct, SqlConfiguration } from '@tslock/sql-support';
import { PgConnection, SqlLockProvider } from '@tslock/sql';
import { Pool } from 'pg';

const pool = new Pool();
const connection = new PgConnection(pool);
const provider = new SqlLockProvider(connection, new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }));
void provider;
`;
    const directory = writeConsumer({ 'consumer.mts': source, 'consumer.cts': source }, ['pg', '@types/pg']);
    const result = typecheck(directory);
    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  });

  it('typechecks a mysql2 pool when mysql2 is installed', () => {
    const source = `import { createPool } from 'mysql2/promise';
import { Mysql2Connection } from '@tslock/sql';

void Mysql2Connection.create(createPool({ host: 'localhost' }));
`;
    const directory = writeConsumer({ 'consumer.mts': source, 'consumer.cts': source }, ['mysql2']);
    const result = typecheck(directory);
    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  });

  it('typechecks an mssql pool when mssql is installed', () => {
    const source = `import { ConnectionPool } from 'mssql';
import { MssqlConnection } from '@tslock/sql';

void new MssqlConnection(new ConnectionPool({ server: 'localhost' }));
`;
    const directory = writeConsumer({ 'consumer.mts': source, 'consumer.cts': source }, ['mssql', '@types/mssql']);
    const result = typecheck(directory);
    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  });
});
