import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const caretRange = /^\^\d+\.\d+\.\d+$/;

let packs;

describe('install fixture', () => {
  before(() => {
    execFileSync('pnpm', ['--filter', '@tslock/core', 'build'], { cwd: root, stdio: 'inherit' });
    execFileSync('pnpm', ['--filter', '@tslock/middleware-core', 'build'], { cwd: root, stdio: 'inherit' });
    execFileSync('pnpm', ['--filter', '@tslock/express', 'build'], { cwd: root, stdio: 'inherit' });
    const destination = mkdtempSync(join(tmpdir(), 'tslock-fixture-packs-'));
    packs = {
      destination,
      core: packPackage('packages/core', destination),
      middleware: packPackage('packages/middleware-core', destination),
      express: packPackage('packages/express', destination),
      redis: packPackage('packages/redis', destination),
    };
  });

  after(() => {
    if (packs) rmSync(packs.destination, { recursive: true, force: true });
  });

  it('packs express and redis with a caret @tslock/core range', () => {
    const expressManifest = readPackedManifest(packs.express);
    const redisManifest = readPackedManifest(packs.redis);
    assert.match(expressManifest.dependencies['@tslock/core'], caretRange);
    assert.match(expressManifest.dependencies['@tslock/middleware-core'], caretRange);
    assert.match(redisManifest.peerDependencies['@tslock/core'], caretRange);
    assert.match(redisManifest.peerDependencies['@tslock/redis-core'], caretRange);
  });

  it('resolves one core copy and shares LockAssert when ranges are caret', async () => {
    const current = readPackedManifest(packs.core);
    const next = nextPatch(current.version);
    const coreNext = repack(packs.core, (manifest) => {
      manifest.version = next;
    });

    await withRegistry(
      [
        publishedFromArchive('@tslock/core', packs.core),
        publishedFromArchive('@tslock/core', coreNext),
        publishedFromArchive('@tslock/middleware-core', packs.middleware),
        publishedFromArchive('@tslock/express', packs.express),
      ],
      async (registry) => {
        const appDir = installApp(registry, [`@tslock/express@${current.version}`, `@tslock/core@${next}`]);
        try {
          const resolved = resolveConsumers(appDir);
          assert.deepEqual(resolved.versions, [next]);
          assert.equal(resolved.appCore, resolved.expressCore);
          assert.equal(resolved.appCore, resolved.middlewareCore);
          assert.equal(resolved.appLockAssert, resolved.expressLockAssert);
          assert.equal(resolved.appLockAssert, resolved.middlewareLockAssert);
          resolved.appLockAssert.runWithLock('job', () => {
            resolved.middlewareLockAssert.assertLocked();
            resolved.expressLockAssert.assertLocked();
            assert.equal(resolved.middlewareLockAssert.alreadyLockedBy('job'), true);
            assert.equal(resolved.expressLockAssert.alreadyLockedBy('job'), true);
          });
        } finally {
          rmSync(appDir, { recursive: true, force: true });
        }
      },
    );
  });

  it('installs a separate core copy when internal ranges are exact', async () => {
    const current = readPackedManifest(packs.core);
    const next = nextPatch(current.version);
    const coreNext = repack(packs.core, (manifest) => {
      manifest.version = next;
    });
    const middleware = repack(packs.middleware, (manifest) => {
      setInternalRanges(manifest, stripCaret);
    });
    const express = repack(packs.express, (manifest) => {
      setInternalRanges(manifest, stripCaret);
    });

    await withRegistry(
      [
        publishedFromArchive('@tslock/core', packs.core),
        publishedFromArchive('@tslock/core', coreNext),
        publishedFromArchive('@tslock/middleware-core', middleware),
        publishedFromArchive('@tslock/express', express),
      ],
      async (registry) => {
        const appDir = installApp(registry, [`@tslock/express@${current.version}`, `@tslock/core@${next}`]);
        try {
          const resolved = resolveConsumers(appDir);
          assert.ok(resolved.versions.includes(current.version));
          assert.ok(resolved.versions.includes(next));
          assert.notEqual(resolved.appCore, resolved.middlewareCore);
          assert.notEqual(resolved.appLockAssert, resolved.middlewareLockAssert);
          assert.equal(
            resolved.appLockAssert.runWithLock('job', () => resolved.middlewareLockAssert.alreadyLockedBy('job')),
            false,
          );
          assert.throws(() => {
            resolved.appLockAssert.runWithLock('job', () => {
              resolved.middlewareLockAssert.assertLocked();
            });
          }, /Expected code to be running under a lock/);
        } finally {
          rmSync(appDir, { recursive: true, force: true });
        }
      },
    );
  });
});

function packPackage(directory, destination) {
  const before = new Set(readdirSync(destination).filter((name) => name.endsWith('.tgz')));
  execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: join(root, directory),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const created = readdirSync(destination).filter((name) => name.endsWith('.tgz') && !before.has(name));
  if (created.length !== 1) throw new Error(`expected one archive from ${directory}, found ${created.length}`);
  return join(destination, created[0]);
}

function publishedFromArchive(name, archive) {
  if (archive.tarball) return { name, version: archive.version, manifest: archive.manifest, tarball: archive.tarball };
  const manifest = readPackedManifest(archive);
  return { name, version: manifest.version, manifest, tarball: readFileSync(archive) };
}

function readPackedManifest(archive) {
  return JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
}

function repack(archive, mutate) {
  const directory = mkdtempSync(join(tmpdir(), 'tslock-repack-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', directory]);
    const manifestPath = join(directory, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    mutate(manifest);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const output = join(directory, 'repacked.tgz');
    execFileSync('tar', ['-czf', output, '-C', directory, 'package']);
    return { version: manifest.version, manifest, tarball: readFileSync(output) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function setInternalRanges(manifest, toRange) {
  for (const section of ['dependencies', 'peerDependencies']) {
    const entries = manifest[section];
    if (!entries) continue;
    for (const name of Object.keys(entries)) {
      if (name.startsWith('@tslock/')) entries[name] = toRange(entries[name]);
    }
  }
}

function stripCaret(range) {
  return range.replace(/^\^/, '');
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`unexpected version ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function filenameFor(name, version) {
  return `${name.slice(name.indexOf('/') + 1)}-${version}.tgz`;
}

function versionMetadata(item, registry) {
  const shasum = createHash('sha1').update(item.tarball).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(item.tarball).digest('base64')}`;
  return {
    ...item.manifest,
    dist: {
      shasum,
      integrity,
      tarball: `${registry}/${item.name}/-/${filenameFor(item.name, item.version)}`,
    },
  };
}

function startRegistry(published) {
  const byName = new Map();
  for (const item of published) {
    const versions = byName.get(item.name) ?? new Map();
    versions.set(item.version, item);
    byName.set(item.name, versions);
  }
  const requests = [];
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    requests.push(`${request.method} ${pathname}`);
    const registry = `http://127.0.0.1:${server.address().port}`;
    if (pathname.startsWith('/-/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const tarball = /^\/(@[^/]+\/[^/]+)\/-\/([^/]+\.tgz)$/.exec(pathname);
    if (tarball) {
      const item = [...(byName.get(tarball[1])?.values() ?? [])].find(
        (entry) => filenameFor(entry.name, entry.version) === tarball[2],
      );
      if (!item) {
        response.writeHead(404);
        response.end('missing tarball');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': item.tarball.length,
      });
      response.end(item.tarball);
      return;
    }
    const versioned = /^\/(@[^/]+\/[^/]+)\/(\d+\.\d+\.\d+)$/.exec(pathname);
    if (versioned) {
      const item = byName.get(versioned[1])?.get(versioned[2]);
      if (!item) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(versionMetadata(item, registry)));
      return;
    }
    const packument = /^\/(@[^/]+\/[^/]+)$/.exec(pathname);
    if (packument) {
      const versions = byName.get(packument[1]);
      if (!versions) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const versionMap = {};
      let latest = '0.0.0';
      for (const item of versions.values()) {
        versionMap[item.version] = versionMetadata(item, registry);
        if (compareVersions(item.version, latest) > 0) latest = item.version;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: packument[1], 'dist-tags': { latest }, versions: versionMap }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

async function withRegistry(published, run) {
  const registry = await startRegistry(published);
  try {
    return await run(registry);
  } finally {
    await new Promise((resolve, reject) => {
      registry.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function installApp(registry, specifiers) {
  const appDir = mkdtempSync(join(tmpdir(), 'tslock-install-fixture-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'tslock-npm-cache-'));
  writeFileSync(
    join(appDir, 'package.json'),
    `${JSON.stringify({ name: 'tslock-install-fixture', private: true, version: '1.0.0' }, null, 2)}\n`,
  );
  try {
    execFileSync(
      'npm',
      [
        'install',
        ...specifiers,
        '--registry',
        registry.url,
        '--cache',
        cacheDir,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--legacy-peer-deps',
        '--install-strategy',
        'hoisted',
      ],
      {
        cwd: appDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_registry: registry.url,
          npm_config_audit: 'false',
          npm_config_fund: 'false',
        },
      },
    );
    return appDir;
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    const stdout = error instanceof Error && 'stdout' in error ? String(error.stdout) : '';
    rmSync(appDir, { recursive: true, force: true });
    throw new Error(`${stderr}\n${stdout}\nregistry requests:\n${registry.requests.join('\n')}`, { cause: error });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function resolveConsumers(appDir) {
  const appRequire = createRequire(join(appDir, 'package.json'));
  const expressManifest = appRequire.resolve('@tslock/express/package.json');
  const middlewareManifest = createRequire(expressManifest).resolve('@tslock/middleware-core/package.json');
  const appCore = appRequire.resolve('@tslock/core/package.json');
  const expressCore = createRequire(expressManifest).resolve('@tslock/core/package.json');
  const middlewareCore = createRequire(middlewareManifest).resolve('@tslock/core/package.json');
  return {
    appCore,
    expressCore,
    middlewareCore,
    versions: findCoreVersions(appDir),
    appLockAssert: appRequire('@tslock/core').LockAssert,
    expressLockAssert: createRequire(expressManifest)('@tslock/core').LockAssert,
    middlewareLockAssert: createRequire(middlewareManifest)('@tslock/core').LockAssert,
  };
}

function findCoreVersions(directory) {
  const versions = [];
  const seenManifests = new Set();
  const seenDirectories = new Set();
  const stack = [join(directory, 'node_modules')];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.bin') continue;
      const next = join(current, entry.name);
      if (!isDirectory(entry, next)) continue;
      const realDirectory = realpathSync(next);
      if (seenDirectories.has(realDirectory)) continue;
      seenDirectories.add(realDirectory);
      if (entry.name === 'core' && current.endsWith(`${sep}@tslock`)) {
        const manifestPath = join(next, 'package.json');
        if (existsSync(manifestPath)) {
          const realManifest = realpathSync(manifestPath);
          if (!seenManifests.has(realManifest)) {
            seenManifests.add(realManifest);
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            if (manifest.name === '@tslock/core') versions.push(manifest.version);
          }
        }
      }
      stack.push(next);
    }
  }
  return versions.sort();
}

function isDirectory(entry, path) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}
