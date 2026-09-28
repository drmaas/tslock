import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findDuplicateMappingKeys, validateLockfileText } from './validate-lockfile.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('validate-lockfile', () => {
  it('accepts the committed pnpm-lock.yaml', () => {
    const text = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    assert.deepEqual(validateLockfileText(text), []);
  });

  it('rejects the duplicated package key that broke frozen install', () => {
    const text = `lockfileVersion: '9.0'
importers:
  .: {}
packages:
  '@types/node@22.20.2':
    resolution: {integrity: sha512-a}
  '@types/node@22.20.2':
    resolution: {integrity: sha512-a}
snapshots:
  '@types/node@22.20.2': {}
`;
    const duplicates = findDuplicateMappingKeys(text);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]?.key, '@types/node@22.20.2');
    assert.equal(duplicates[0]?.line, 7);
    const errors = validateLockfileText(text);
    assert.match(errors[0] ?? '', /duplicated mapping key "@types\/node@22\.20\.2" at 7:/);
  });

  it('rejects a duplicated snapshot key', () => {
    const text = `lockfileVersion: '9.0'
importers:
  .: {}
packages:
  esbuild@0.27.7:
    resolution: {integrity: sha512-a}
snapshots:
  esbuild@0.27.7: {}
  esbuild@0.27.7: {}
`;
    const duplicates = findDuplicateMappingKeys(text);
    assert.equal(
      duplicates.some((duplicate) => duplicate.key === 'esbuild@0.27.7' && duplicate.line === 9),
      true,
    );
  });

  it('rejects a duplicated key inside a flow mapping', () => {
    const text = `lockfileVersion: '9.0'
importers:
  .: {}
packages:
  esbuild@0.27.7:
    resolution: {integrity: sha512-a, integrity: sha512-b}
snapshots:
  esbuild@0.27.7: {}
`;
    const errors = validateLockfileText(text);
    assert.match(errors.join('\n'), /duplicated mapping key "integrity"/);
  });

  it('allows the same key under different parents', () => {
    const text = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      tsup:
        specifier: ^8.5.1
        version: 8.5.1
  packages/core:
    devDependencies:
      tsup:
        specifier: ^8.0.0
        version: 8.5.1
packages: {}
`;
    assert.deepEqual(findDuplicateMappingKeys(text), []);
  });

  it('rejects a missing lockfileVersion', () => {
    const errors = validateLockfileText('importers:\npackages:\n');
    assert.match(errors.join('\n'), /lockfileVersion/);
  });
});
