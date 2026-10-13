import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageExportProblems, scannedWorkspacePackages, workspacePackageExportProblems } from './check-exports.mjs';

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
