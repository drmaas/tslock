import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  declarationImportProblems,
  packageExportProblems,
  scannedWorkspacePackages,
  sqlDriverImportProblems,
  workspacePackageExportProblems,
} from './check-exports.mjs';

const validPackage = {
  name: '@tslock/example',
  main: './dist/index.cjs',
  module: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      import: {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
      require: {
        types: './dist/index.d.cts',
        default: './dist/index.cjs',
      },
    },
    './package.json': './package.json',
  },
};

describe('package exports', () => {
  it('accepts nested import and require type conditions', () => {
    assert.deepEqual(packageExportProblems(validPackage), []);
  });

  it('rejects a flat types condition that CommonJS node16 resolves as ESM', () => {
    const problems = packageExportProblems({
      ...validPackage,
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          require: './dist/index.cjs',
        },
        './package.json': './package.json',
      },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /exports\["\."\]/);
  });

  it('rejects types placed after import and require', () => {
    const problems = packageExportProblems({
      ...validPackage,
      exports: {
        '.': {
          import: './dist/index.js',
          require: './dist/index.cjs',
          types: './dist/index.d.ts',
        },
        './package.json': './package.json',
      },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /exports\["\."\]/);
  });

  it('rejects an extra subpath export that does not split types', () => {
    const problems = packageExportProblems({
      ...validPackage,
      exports: {
        ...validPackage.exports,
        './extra': {
          types: './dist/extra.d.ts',
          import: './dist/extra.js',
          require: './dist/extra.cjs',
        },
      },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /unexpected export "\.\/extra"/);
  });

  it('accepts every workspace package', () => {
    assert.deepEqual(workspacePackageExportProblems(), []);
  });

  it('scans every publishable lockstep package', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
    const changeset = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8'));
    assert.deepEqual(changeset.fixed, [['@tslock/*']]);
    assert.deepEqual(changeset.ignore, []);

    const onDisk = readdirSync(join(root, 'packages'))
      .filter((name) => existsSync(join(root, 'packages', name, 'package.json')))
      .sort();
    const scanned = scannedWorkspacePackages();
    assert.deepEqual(scanned.map((pkg) => pkg.directory.split('/').at(-1)).sort(), onDisk);
    for (const { packageJson } of scanned) {
      assert.equal(packageJson.private, undefined);
      assert.match(packageJson.name, /^@tslock\//);
    }
  });
});

function withDeclarationFixture(files, run) {
  const directory = mkdtempSync(join(tmpdir(), 'tslock-declaration-imports-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const file = join(directory, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('declaration imports', () => {
  it('rejects an undeclared mssql import', () => {
    const packageJson = {
      name: '@tslock/example',
      devDependencies: { mssql: '^12.7.0' },
      peerDependencies: { '@tslock/core': 'workspace:*' },
    };
    const problems = withDeclarationFixture(
      {
        'dist/index.d.ts': "import { ConnectionPool } from 'mssql';\nexport declare class Example {}\n",
        'dist/index.d.cts': "export type Connection = import('mssql').ConnectionPool;\n",
        'dist/nested/extra.d.ts': "import type { Pool } from 'mysql2/promise';\nexport type Nested = Pool;\n",
      },
      (directory) => declarationImportProblems(directory, packageJson),
    );
    assert.deepEqual(problems, [
      "@tslock/example: dist/index.d.cts imports 'mssql', which is not declared in dependencies or peerDependencies",
      "@tslock/example: dist/index.d.ts imports 'mssql', which is not declared in dependencies or peerDependencies",
      "@tslock/example: dist/nested/extra.d.ts imports 'mysql2/promise', which is not declared in dependencies or peerDependencies",
    ]);
  });

  it('accepts an optional peer import', () => {
    const packageJson = {
      name: '@tslock/example',
      peerDependencies: { mssql: '^12.7.0', '@tslock/core': 'workspace:*' },
      peerDependenciesMeta: { mssql: { optional: true } },
    };
    const problems = withDeclarationFixture(
      {
        'dist/index.d.ts': "import { ConnectionPool } from 'mssql';\nexport declare const pool: ConnectionPool;\n",
        'dist/index.d.cts':
          "import { AsyncLocalStorage } from 'node:async_hooks';\nexport { StorageBasedLockProvider } from '@tslock/core';\nexport type Storage = AsyncLocalStorage<unknown>;\n",
      },
      (directory) => declarationImportProblems(directory, packageJson),
    );
    assert.deepEqual(problems, []);
  });

  it('accepts @tslock/sql entry declarations only without driver imports', () => {
    const packageJson = {
      name: '@tslock/sql',
      peerDependencies: {
        '@tslock/core': 'workspace:*',
        '@tslock/sql-support': 'workspace:*',
        pg: '^8.11.0',
        mysql2: '^3.23.1',
        mssql: '^12.7.0',
        '@types/pg': '^8.10.0',
        '@types/mssql': '^12.3.0',
      },
      peerDependenciesMeta: {
        pg: { optional: true },
        mysql2: { optional: true },
        mssql: { optional: true },
        '@types/pg': { optional: true },
        '@types/mssql': { optional: true },
      },
    };
    const structural = `export declare class PgConnection {
  constructor(pool: { query(sql: string, values: readonly unknown[]): Promise<{ rowCount: number | null }> });
}
`;
    const clean = withDeclarationFixture(
      {
        'dist/index.d.ts': structural,
        'dist/index.d.cts': structural,
      },
      (directory) => ({
        imports: declarationImportProblems(directory, packageJson),
        drivers: sqlDriverImportProblems(directory),
      }),
    );
    assert.deepEqual(clean.imports, []);
    assert.deepEqual(clean.drivers, []);

    const dirty = withDeclarationFixture(
      {
        'dist/index.d.ts':
          "import { Pool } from 'pg';\nexport declare class PgConnection { constructor(pool: Pool); }\n",
        'dist/index.d.cts':
          "import { Pool } from 'mysql2/promise';\nimport { ConnectionPool } from 'mssql';\nexport declare class Example {}\n",
      },
      (directory) => ({
        imports: declarationImportProblems(directory, packageJson),
        drivers: sqlDriverImportProblems(directory),
      }),
    );
    assert.deepEqual(dirty.imports, []);
    assert.deepEqual(dirty.drivers, [
      "@tslock/sql: dist/index.d.cts imports 'mysql2/promise'",
      "@tslock/sql: dist/index.d.cts imports 'mssql'",
      "@tslock/sql: dist/index.d.ts imports 'pg'",
    ]);
  });
});
