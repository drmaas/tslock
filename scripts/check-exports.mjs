import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const packagesRoot = join(root, 'packages');

const rootEntry = {
  import: {
    types: './dist/index.d.ts',
    default: './dist/index.js',
  },
  require: {
    types: './dist/index.d.cts',
    default: './dist/index.cjs',
  },
};

export function packageExportProblems(packageJson) {
  const name = typeof packageJson?.name === 'string' ? packageJson.name : '<unknown>';
  const problems = [];
  if (packageJson?.main !== './dist/index.cjs') {
    problems.push(`${name}: main must stay ./dist/index.cjs`);
  }
  if (packageJson?.module !== './dist/index.js') {
    problems.push(`${name}: module must stay ./dist/index.js`);
  }
  if (packageJson?.types !== './dist/index.d.ts') {
    problems.push(`${name}: top-level types must stay ./dist/index.d.ts`);
  }

  const exportsField = packageJson?.exports;
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    problems.push(`${name}: exports must be an object`);
    return problems;
  }

  if (!orderedEqual(exportsField['.'], rootEntry)) {
    problems.push(
      `${name}: exports["."] must nest import types at ./dist/index.d.ts and require types at ./dist/index.d.cts`,
    );
  }
  if (exportsField['./package.json'] !== './package.json') {
    problems.push(`${name}: exports["./package.json"] must stay "./package.json"`);
  }

  for (const key of Object.keys(exportsField)) {
    if (key === '.' || key === './package.json') continue;
    problems.push(`${name}: unexpected export ${JSON.stringify(key)} needs the same import/require types split`);
  }

  return problems;
}

export function workspacePackageExportProblems() {
  const problems = [];
  for (const { packageJson } of scannedWorkspacePackages()) {
    problems.push(...packageExportProblems(packageJson));
  }
  return problems;
}

const SQL_DRIVER_SPECIFIER = /^(?:pg|mysql2|mssql)(?:\/.*)?$/;

export function declarationImportProblems(directory, packageJson) {
  const name = typeof packageJson?.name === 'string' ? packageJson.name : '<unknown>';
  const declared = new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.peerDependencies ?? {}),
  ]);
  const dist = join(directory, 'dist');
  if (!existsSync(dist)) {
    return [`${name}: dist is missing, so declaration imports cannot be checked`];
  }

  const files = declarationFiles(dist);
  if (files.length === 0) {
    return [`${name}: dist has no declaration files`];
  }

  const problems = [];
  for (const file of files) {
    const relativePath = relative(directory, file);
    for (const specifier of importedSpecifiers(readFileSync(file, 'utf8'))) {
      const dependency = barePackageName(specifier);
      if (dependency === null || declared.has(dependency)) continue;
      problems.push(
        `${name}: ${relativePath} imports '${specifier}', which is not declared in dependencies or peerDependencies`,
      );
    }
  }
  return problems;
}

export function sqlDriverImportProblems(directory) {
  const problems = [];
  for (const relativePath of ['dist/index.d.ts', 'dist/index.d.cts']) {
    if (!existsSync(join(directory, relativePath))) {
      problems.push(`@tslock/sql: missing ${relativePath}`);
    }
  }

  const dist = join(directory, 'dist');
  if (!existsSync(dist)) return problems;

  for (const file of declarationFiles(dist)) {
    const relativePath = relative(directory, file);
    for (const specifier of importedSpecifiers(readFileSync(file, 'utf8'))) {
      if (!SQL_DRIVER_SPECIFIER.test(specifier)) continue;
      problems.push(`@tslock/sql: ${relativePath} imports '${specifier}'`);
    }
  }
  return problems;
}

export function workspaceDeclarationImportProblems() {
  const problems = [];
  for (const { directory, packageJson } of scannedWorkspacePackages()) {
    problems.push(...declarationImportProblems(directory, packageJson));
    if (packageJson.name === '@tslock/sql') {
      problems.push(...sqlDriverImportProblems(directory));
    }
  }
  return problems;
}

export function scannedWorkspacePackages() {
  return workspacePackageDirectories().map((directory) => {
    const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return { directory, packageJson };
  });
}

function declarationFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...declarationFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.cts'))) {
      files.push(path);
    }
  }
  return files.sort();
}

function importedSpecifiers(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specifiers = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function barePackageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) return null;
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    if (!name) return specifier;
    return `${scope}/${name}`;
  }
  const [name] = specifier.split('/');
  return name || null;
}

function workspacePackageDirectories() {
  return readdirSync(packagesRoot)
    .map((name) => join(packagesRoot, name))
    .filter((directory) => existsSync(join(directory, 'package.json')))
    .sort();
}

function orderedEqual(actual, expected) {
  if (typeof expected !== 'object' || expected === null) return actual === expected;
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    if (actualKeys[index] !== key) return false;
    if (!orderedEqual(actual[key], expected[key])) return false;
  }
  return true;
}

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output: `${stdout}${stderr}`.trim() });
    });
  });
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function lintBuiltPackages() {
  const publintBin = join(root, 'node_modules', '.bin', 'publint');
  const attwBin = join(root, 'node_modules', '.bin', 'attw');
  if (!existsSync(publintBin) || !existsSync(attwBin)) {
    return ['publint and @arethetypeswrong/cli must be installed (pnpm install) before check:exports'];
  }

  const directories = workspacePackageDirectories();
  const results = await mapPool(directories, 6, async (directory) => {
    const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const failures = [];
    const publint = await run(publintBin, ['--strict'], directory);
    if (publint.code !== 0) {
      failures.push(`${packageJson.name}: publint --strict failed\n${publint.output}`);
    }
    const attw = await run(attwBin, ['--pack', '.'], directory);
    if (attw.code !== 0) {
      failures.push(`${packageJson.name}: attw --pack failed\n${attw.output}`);
    }
    return failures;
  });
  return results.flat();
}

async function main() {
  const shapeProblems = [...workspacePackageExportProblems(), ...workspaceDeclarationImportProblems()];
  if (shapeProblems.length > 0) {
    console.error(shapeProblems.join('\n'));
    process.exitCode = 1;
    return;
  }

  const toolProblems = await lintBuiltPackages();
  if (toolProblems.length > 0) {
    console.error(toolProblems.join('\n\n'));
    process.exitCode = 1;
    return;
  }

  const count = workspacePackageDirectories().length;
  console.log(`publint --strict, attw --pack, and declaration import checks passed for ${count} packages.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
