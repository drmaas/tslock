import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { KnipConfig } from 'knip';

const packageNames = readdirSync('packages')
  .filter((name) => existsSync(join('packages', name, 'package.json')))
  .sort();

function hasDeclarationFile(directory: string): boolean {
  if (!existsSync(directory)) return false;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (hasDeclarationFile(path)) return true;
    } else if (name.endsWith('.d.ts')) {
      return true;
    }
  }
  return false;
}

const workspaces: NonNullable<KnipConfig['workspaces']> = {
  '.': {
    entry: ['scripts/*.{cjs,mjs}', 'benchmarks/*.mjs'],
    project: ['scripts/**/*.{cjs,mjs}', 'benchmarks/**/*.mjs'],
  },
};

for (const name of packageNames) {
  const root = join('packages', name);
  // tsup.config.ts marks src/index.ts as the package entry. vitest.config.ts and
  // vitest.integration.config.ts are config/script entries. List the files those plugins do not cover.
  const entry = [];
  const project = ['src/**/*.ts!'];
  if (existsSync(join(root, '__tests__'))) {
    entry.push('__tests__/**/*.ts');
    project.push('__tests__/**/*.ts');
  }
  if (existsSync(join(root, 'examples'))) {
    entry.push('examples/**/*.{ts,mjs,js}');
    project.push('examples/**/*.{ts,mjs,js}');
  }
  if (hasDeclarationFile(join(root, 'src'))) {
    entry.push('src/**/*.d.ts');
  }
  workspaces[`packages/${name}`] = { entry, project };
}

const config: KnipConfig = {
  ignoreDependencies: [
    // scripts/check-exports.mjs spawns these from node_modules/.bin rather than importing them.
    'publint',
    '@arethetypeswrong/cli',
    // scripts/resolve-typescript6.cjs loads this through Module._load when tsup requires "typescript".
    '@typescript/typescript6',
  ],
  ignoreIssues: {
    // DEL_SCRIPT, EXTEND_SCRIPT, and KEEP_SCRIPT are documented public aliases of the *_IF_EQUALS_SCRIPT sources.
    'packages/redis-core/src/scripts.ts': ['duplicates'],
  },
  workspaces,
};

export default config;
