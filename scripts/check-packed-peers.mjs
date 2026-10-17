import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const packagesRoot = join(root, 'packages');

const PUBLISHED_TSLOCK_RANGE = /^\^\d+\.\d+\.\d+$/;

export function packedInternalRangeProblems(packageName, packedPackageJson) {
  const problems = [];
  for (const section of ['dependencies', 'peerDependencies']) {
    const entries = packedPackageJson?.[section];
    if (!entries || typeof entries !== 'object') continue;
    for (const [dependency, range] of Object.entries(entries)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        problems.push(`${packageName}: ${section}.${dependency} is ${range}`);
        continue;
      }
      if (!dependency.startsWith('@tslock/')) continue;
      if (typeof range !== 'string' || !PUBLISHED_TSLOCK_RANGE.test(range)) {
        problems.push(`${packageName}: ${section}.${dependency} is ${String(range)}`);
      }
    }
  }
  return problems;
}

function checkPackedPackages() {
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
      failures.push(...packedInternalRangeProblems(packageJson.name, packedPackageJson));
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
  return failures;
}

function main() {
  const failures = checkPackedPackages();
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('Packed @tslock dependency and peer ranges are caret versions for all @tslock/* packages.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
