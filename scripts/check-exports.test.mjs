import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { packageExportProblems, workspacePackageExportProblems } from './check-exports.mjs';

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
});
