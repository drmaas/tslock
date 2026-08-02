import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const packagesRoot = join(root, 'packages');
const failures = [];

for (const packageName of readdirSync(packagesRoot)) {
  const packageDirectory = join(packagesRoot, packageName);
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  } catch {
    continue;
  }

  if (!packageJson.name?.startsWith('@tslock/')) continue;
  const destination = mkdtempSync(join(tmpdir(), 'tslock-packed-peer-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: packageDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const archives = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
    if (archives.length !== 1) {
      failures.push(`${packageJson.name}: expected one packed archive, found ${archives.length}`);
      continue;
    }

    const archive = join(destination, archives[0]);
    const packedManifest = execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' });
    const packedPackageJson = JSON.parse(packedManifest);
    for (const [dependency, range] of Object.entries(packedPackageJson.peerDependencies ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        failures.push(`${packageJson.name}: peerDependencies.${dependency} is ${range}`);
      }
    }
  } catch (error) {
    const detail =
      error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    failures.push(`${packageJson.name}: ${detail}`);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Packed peer dependency check passed for all @tslock/* packages.');
}
