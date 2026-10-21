import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { peerDevRangeProblems, rangesIntersect, workspacePeerDevRangeProblems } from './check-peer-dev-ranges.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('peer and devDependency range intersection', () => {
  it('intersects caret, tilde, comparator, and 0.x ranges when a version satisfies both', () => {
    assert.equal(rangesIntersect('^4.0.0 || ^5.0.0 || ^6.0.0', '^6.2.1'), true);
    assert.equal(rangesIntersect('^5.0.0 || ^6.0.0', '^6.0.0'), true);
    assert.equal(rangesIntersect('^2.0.0 || ^3.0.0', '^3.2.1'), true);
    assert.equal(rangesIntersect('^4.0.0 || ^5.0.0', '^4.21.0 || ^5.0.0'), true);
    assert.equal(rangesIntersect('^10.0.0 || ^11.0.0 || ^12.0.0', '^12.1.1'), true);
    assert.equal(rangesIntersect('^7.1.0', '^7.8.1'), true);
    assert.equal(rangesIntersect('^8.10.0', '^8.11.0'), true);
    assert.equal(rangesIntersect('^0.45.2', '^0.45.2'), true);
    assert.equal(rangesIntersect('^0.29.6', '^0.29.6'), true);
    assert.equal(rangesIntersect('^0.0.3', '^0.0.3'), true);
    assert.equal(rangesIntersect('~1.2.3', '^1.2.0'), true);
    assert.equal(rangesIntersect('>=1.2.3 <2.0.0', '^1.5.0'), true);
    assert.equal(rangesIntersect('*', '^6.2.1'), true);
    assert.equal(rangesIntersect('4', '^4.2.1'), true);
    assert.equal(rangesIntersect('1.2', '^1.2.9'), true);
    assert.equal(rangesIntersect('1.2.3', '^1.2.0'), true);
  });

  it('does not intersect ranges that share no version', () => {
    assert.equal(rangesIntersect('^4.0.0', '^6.2.1'), false);
    assert.equal(rangesIntersect('^5.0.0', '^6.0.0'), false);
    assert.equal(rangesIntersect('^2.0.0', '^3.2.1'), false);
    assert.equal(rangesIntersect('^0.45.2', '^0.46.0'), false);
    assert.equal(rangesIntersect('^0.0.3', '^0.0.4'), false);
    assert.equal(rangesIntersect('~1.2.3', '^1.3.0'), false);
    assert.equal(rangesIntersect('>=1.0.0 <2.0.0', '^2.0.0'), false);
    assert.equal(rangesIntersect('4', '^5.0.0'), false);
    assert.equal(rangesIntersect('1.2.3', '^1.3.0'), false);
    assert.equal(rangesIntersect('>1.0.0', '1.0.0'), false);
  });

  it('rejects a devDependency major its peer does not list', () => {
    const problems = peerDevRangeProblems({
      name: '@tslock/redis',
      peerDependencies: { redis: '^4.0.0 || ^5.0.0 || ^6.0.0' },
      devDependencies: { redis: '^7.0.0', typescript: '^7.0.2' },
    });
    assert.deepEqual(problems, [
      '@tslock/redis: devDependencies.redis (^7.0.0) does not intersect peerDependencies.redis (^4.0.0 || ^5.0.0 || ^6.0.0)',
    ]);
  });

  it('rejects a devDependency range that cannot be compared', () => {
    const problems = peerDevRangeProblems({
      name: '@tslock/koa',
      peerDependencies: { koa: 'github:koajs/koa' },
      devDependencies: { koa: '^3.2.1' },
    });
    assert.deepEqual(problems, [
      '@tslock/koa: devDependencies.koa (^3.2.1) could not be compared with peerDependencies.koa (github:koajs/koa)',
    ]);
  });

  it('ignores @tslock ranges, peers without a devDependency, and devDependencies without a peer', () => {
    assert.deepEqual(
      peerDevRangeProblems({
        name: '@tslock/redis',
        peerDependencies: {
          '@tslock/core': 'workspace:^',
          redis: '^4.0.0 || ^5.0.0 || ^6.0.0',
        },
        devDependencies: {
          '@tslock/core': 'not-a-range',
          redis: '^6.2.1',
          typescript: '^7.0.0',
        },
      }),
      [],
    );
    assert.deepEqual(
      peerDevRangeProblems({
        name: '@tslock/node-cron',
        peerDependencies: { 'node-cron': '^3.0.0 || ^4.0.0' },
        devDependencies: { vitest: '^5.0.3' },
      }),
      [],
    );
  });

  it('accepts redis, ioredis, and koa devDependencies while keeping the older majors', () => {
    const cases = [
      ['packages/redis/package.json', 'redis', ['^4.0.0', '^5.0.0', '^6.0.0']],
      ['packages/redis-ioredis/package.json', 'ioredis', ['^5.0.0', '^6.0.0']],
      ['packages/koa/package.json', 'koa', ['^2.0.0', '^3.0.0']],
    ];
    for (const [manifestPath, dependency, majors] of cases) {
      const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
      const peerRange = manifest.peerDependencies[dependency];
      const devRange = manifest.devDependencies[dependency];
      const alternatives = peerRange.split('||').map((part) => part.trim());
      for (const major of majors) {
        assert.ok(alternatives.includes(major), `${dependency} peer ${peerRange} is missing ${major}`);
      }
      assert.equal(rangesIntersect(peerRange, devRange), true, `${dependency} dev ${devRange} vs peer ${peerRange}`);
    }
  });

  it('accepts every committed workspace manifest', () => {
    assert.deepEqual(workspacePeerDevRangeProblems(root), []);
  });
});
