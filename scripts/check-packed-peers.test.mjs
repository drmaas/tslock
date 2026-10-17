import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packedInternalRangeProblems } from './check-packed-peers.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('packed internal ranges', () => {
  it('accepts caret ranges for packed @tslock dependencies and peers', () => {
    assert.deepEqual(
      packedInternalRangeProblems('@tslock/express', {
        dependencies: {
          '@tslock/core': '^2.3.1',
          '@tslock/middleware-core': '^2.3.1',
        },
        peerDependencies: {
          express: '^4.0.0 || ^5.0.0',
        },
      }),
      [],
    );
    assert.deepEqual(
      packedInternalRangeProblems('@tslock/redis', {
        peerDependencies: {
          '@tslock/core': '^2.3.1',
          '@tslock/redis-core': '^2.3.1',
          redis: '^4.0.0',
        },
      }),
      [],
    );
  });

  it('rejects an exact @tslock dependency', () => {
    const problems = packedInternalRangeProblems('@tslock/express', {
      dependencies: {
        '@tslock/core': '2.3.1',
        '@tslock/middleware-core': '^2.3.1',
      },
    });
    assert.deepEqual(problems, ['@tslock/express: dependencies.@tslock/core is 2.3.1']);
  });

  it('rejects an exact @tslock peer', () => {
    const problems = packedInternalRangeProblems('@tslock/redis', {
      peerDependencies: {
        '@tslock/core': '2.3.1',
        '@tslock/redis-core': '^2.3.1',
        redis: '4.0.0',
      },
    });
    assert.deepEqual(problems, ['@tslock/redis: peerDependencies.@tslock/core is 2.3.1']);
  });

  it('rejects a leftover workspace protocol', () => {
    const problems = packedInternalRangeProblems('@tslock/redis', {
      dependencies: {
        '@tslock/core': 'workspace:^',
      },
      peerDependencies: {
        redis: 'workspace:*',
      },
    });
    assert.deepEqual(problems, [
      '@tslock/redis: dependencies.@tslock/core is workspace:^',
      '@tslock/redis: peerDependencies.redis is workspace:*',
    ]);
  });

  it('rejects tilde and incomplete caret ranges', () => {
    const problems = packedInternalRangeProblems('@tslock/example', {
      dependencies: {
        '@tslock/core': '^2.3',
      },
      peerDependencies: {
        '@tslock/redis-core': '~2.3.1',
      },
    });
    assert.deepEqual(problems, [
      '@tslock/example: dependencies.@tslock/core is ^2.3',
      '@tslock/example: peerDependencies.@tslock/redis-core is ~2.3.1',
    ]);
  });

  it('keeps devDependencies on workspace:* and publishes dependencies and peers as workspace:^', () => {
    const packagesRoot = join(root, 'packages');
    const checked = [];
    for (const directory of readdirSync(packagesRoot)) {
      const packageJson = JSON.parse(readFileSync(join(packagesRoot, directory, 'package.json'), 'utf8'));
      checked.push(packageJson.name);
      for (const section of ['dependencies', 'peerDependencies']) {
        for (const [name, range] of Object.entries(packageJson[section] ?? {})) {
          if (!name.startsWith('@tslock/')) continue;
          assert.equal(range, 'workspace:^', `${packageJson.name} ${section}.${name}`);
        }
      }
      for (const [name, range] of Object.entries(packageJson.devDependencies ?? {})) {
        if (!name.startsWith('@tslock/')) continue;
        assert.equal(range, 'workspace:*', `${packageJson.name} devDependencies.${name}`);
      }
    }
    assert.ok(checked.includes('@tslock/express'));
    assert.ok(checked.includes('@tslock/redis'));
  });
});
