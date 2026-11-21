import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { versionSatisfiesRange } from './check-peer-dev-ranges.mjs';

const LOCKFILE_NAME = 'pnpm-lock.yaml';
const WORKSPACE_NAME = 'pnpm-workspace.yaml';

export function findDuplicateMappingKeys(text) {
  const duplicates = [];
  const stack = [{ indent: -1, keys: new Set() }];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.startsWith('\t')) {
      duplicates.push({
        line: index + 1,
        column: 1,
        key: '(tab indentation)',
      });
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const trimmed = line.slice(indent);
    if (trimmed === '---') {
      stack.length = 0;
      stack.push({ indent: -1, keys: new Set() });
      continue;
    }
    if (trimmed.startsWith('- ')) continue;

    const parsed = splitMappingKey(trimmed);
    if (!parsed) continue;

    while (stack.length > 1 && stack[stack.length - 1].indent > indent) stack.pop();
    const top = stack[stack.length - 1];
    if (!top || top.indent !== indent) {
      stack.push({ indent, keys: new Set() });
    }
    const mapping = stack[stack.length - 1];
    if (!mapping) continue;
    if (mapping.keys.has(parsed.key)) {
      duplicates.push({ line: index + 1, column: indent + 1, key: parsed.key });
      continue;
    }
    mapping.keys.add(parsed.key);
    for (const key of duplicateFlowMapKeys(trimmed)) {
      duplicates.push({ line: index + 1, column: indent + 1, key });
    }
  }

  return duplicates;
}

function duplicateFlowMapKeys(text) {
  const duplicates = [];
  collectFlowMapDuplicates(text, duplicates);
  return duplicates;
}

function collectFlowMapDuplicates(text, duplicates) {
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "'" || character === '"') {
      index = skipQuoted(text, index);
      continue;
    }
    if (character === '{') {
      const end = matchingBrace(text, index);
      if (end < 0) return;
      const body = text.slice(index + 1, end);
      const seen = new Set();
      for (const key of depthZeroKeys(body)) {
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
      collectFlowMapDuplicates(body, duplicates);
      index = end + 1;
      continue;
    }
    index += 1;
  }
}

function depthZeroKeys(body) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      current += character;
      if (character === '\\') {
        current += body[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '{' || character === '[') {
      depth += 1;
      current += character;
      continue;
    }
    if (character === '}' || character === ']') {
      depth -= 1;
      current += character;
      continue;
    }
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') parts.push(current);

  const keys = [];
  for (const part of parts) {
    const key = keyBeforeColon(part.trim());
    if (key) keys.push(key);
  }
  return keys;
}

function keyBeforeColon(part) {
  if (part.startsWith("'") || part.startsWith('"')) {
    const quote = part[0];
    let key = '';
    for (let index = 1; index < part.length; index += 1) {
      const character = part[index];
      if (character === '\\') {
        key += part[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (character === quote) {
        return part[index + 1] === ':' ? key : undefined;
      }
      key += character;
    }
    return undefined;
  }

  const colon = part.indexOf(':');
  if (colon <= 0) return undefined;
  return part.slice(0, colon).trim();
}

function matchingBrace(text, openIndex) {
  let depth = 0;
  let quote = '';
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipQuoted(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index + 1;
  }
  return text.length;
}

export function validateLockfileText(text) {
  const errors = [];
  if (!/^lockfileVersion:\s*['"]9\.0['"]\s*$/m.test(text)) {
    errors.push("expected lockfileVersion: '9.0' (packageManager pnpm@12.10.1).");
  }
  if (!/^importers:\s*$/m.test(text) || !/^packages:\s*$/m.test(text)) {
    errors.push('expected top-level importers: and packages: sections.');
  }

  for (const duplicate of findDuplicateMappingKeys(text)) {
    if (duplicate.key === '(tab indentation)') {
      errors.push(`tab indentation at ${duplicate.line}:${duplicate.column}; pnpm-lock.yaml must use spaces.`);
      continue;
    }
    errors.push(`duplicated mapping key ${JSON.stringify(duplicate.key)} at ${duplicate.line}:${duplicate.column}`);
  }

  return errors;
}

export function validateLockfileFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [`unable to read ${filePath}: ${detail}`];
  }
  return validateLockfileText(text);
}

function readTextFile(filePath) {
  try {
    return { text: readFileSync(filePath, 'utf8') };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `unable to read ${filePath}: ${detail}` };
  }
}

function parseOverrideEntry(trimmed) {
  let index = 0;
  let quote = '';
  let key = '';

  if (trimmed[0] === "'" || trimmed[0] === '"') {
    quote = trimmed[0];
    index = 1;
  }

  for (; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote) {
      if (character === '\\') {
        key += trimmed[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = '';
        continue;
      }
      key += character;
      continue;
    }
    if (character === ':') {
      if (key.length === 0) return undefined;
      const value = trimmed.slice(index + 1).trim();
      return { key, value };
    }
    if (character === ' ' || character === '#' || character === '{' || character === '[') return undefined;
    key += character;
  }

  return undefined;
}

export function parseBareWorkspaceOverrides(workspaceText) {
  const overrides = [];
  const lines = workspaceText.split(/\r?\n/);
  let inOverrides = false;

  for (const line of lines) {
    if (/^overrides:\s*$/.test(line)) {
      inOverrides = true;
      continue;
    }
    if (inOverrides && /^[^\s#]/.test(line)) break;
    if (!inOverrides || !line.startsWith('  ')) continue;

    const parsed = parseOverrideEntry(line.trimStart());
    if (!parsed) continue;

    let name;
    let range;
    let parent;
    const nestedIndex = parsed.key.indexOf('>');
    if (nestedIndex >= 0) {
      parent = parsed.key.slice(0, nestedIndex);
      name = parsed.key.slice(nestedIndex + 1);
      if (!parent || !name) continue;
      range = undefined;
    } else if (parsed.key.endsWith('@')) {
      name = parsed.key.slice(0, -1);
      range = undefined;
    } else {
      const at = parsed.key.lastIndexOf('@');
      if (at > 0) {
        name = parsed.key.slice(0, at);
        range = parsed.key.slice(at + 1);
        if (!range) continue;
      } else {
        name = parsed.key;
        range = undefined;
      }
    }

    const entry = {
      overrideKey: parsed.key,
      name,
      range,
      expectedVersion: parsed.value,
    };
    if (parent !== undefined) {
      entry.parent = parent;
    }
    overrides.push(entry);
  }

  return overrides;
}

function stripYamlQuotes(key) {
  if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
    return key.slice(1, -1);
  }
  return key;
}

function lockfileMainDocument(lockfileText) {
  const parts = lockfileText.split(/\r?\n---\r?\n/);
  if (parts.length >= 2) return parts.slice(1).join('\n---\n');
  return lockfileText;
}

export function collectLockfilePackageKeys(lockfileText) {
  const keys = [];
  const lines = lockfileMainDocument(lockfileText).split(/\r?\n/);
  let inPackages = false;

  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^snapshots:\s*$/.test(line)) break;
    if (inPackages && /^[^\s#]/.test(line)) break;
    if (!inPackages || !/^ {2}[^:\s]/.test(line)) continue;

    const colon = line.indexOf(':', 2);
    if (colon < 0) continue;
    const rest = line.slice(colon + 1).trim();
    if (rest !== '' && !rest.startsWith('{')) continue;

    keys.push(stripYamlQuotes(line.slice(2, colon).trim()));
  }

  return keys;
}

function normalizeSnapshotDependencyVersion(version) {
  const trimmed = version.trim();
  if (trimmed.startsWith('workspace:') || trimmed.startsWith('link:')) {
    return undefined;
  }
  const paren = trimmed.indexOf('(');
  return (paren >= 0 ? trimmed.slice(0, paren) : trimmed).trim();
}

function collectSnapshotDependencyVersions(lockfileText) {
  const versionsByName = new Map();
  const lines = lockfileMainDocument(lockfileText).split(/\r?\n/);
  let inSnapshots = false;

  for (const line of lines) {
    if (/^snapshots:\s*$/.test(line)) {
      inSnapshots = true;
      continue;
    }
    if (!inSnapshots) continue;

    const match = /^ {6}([^:\s]+): ([^\s]+)\s*$/.exec(line);
    if (!match) continue;

    const [, name, version] = match;
    const normalized = normalizeSnapshotDependencyVersion(version);
    if (normalized === undefined || (!/^\d/.test(normalized) && !/^[\d.]+/.test(normalized))) {
      continue;
    }

    const bucket = versionsByName.get(name) ?? new Set();
    bucket.add(normalized);
    versionsByName.set(name, bucket);
  }

  return versionsByName;
}

export function validateWorkspaceOverrides(workspaceText, lockfileText) {
  const errors = [];
  const bareOverrides = parseBareWorkspaceOverrides(workspaceText);
  if (bareOverrides.length === 0) return errors;

  const packageKeys = collectLockfilePackageKeys(lockfileText);
  const snapshotVersions = collectSnapshotDependencyVersions(lockfileText);

  for (const { overrideKey, name, range, expectedVersion } of bareOverrides) {
    const matches = packageKeys.filter((key) => {
      const prefix = `${name}@`;
      if (!key.startsWith(prefix)) return false;
      const version = key.slice(prefix.length);
      if (range === undefined) return true;
      return versionSatisfiesRange(version, range);
    });
    const expectedKey = `${name}@${expectedVersion}`;

    if (matches.length === 0) {
      if (range === undefined) {
        errors.push(
          `workspace override ${JSON.stringify(overrideKey)} pins ${expectedVersion}, but pnpm-lock.yaml packages: has no ${JSON.stringify(expectedKey)} entry.`,
        );
        continue;
      }
    } else if (matches.length > 1) {
      errors.push(
        `workspace override ${JSON.stringify(overrideKey)} pins ${expectedVersion}, but pnpm-lock.yaml packages: has multiple versions: ${matches.map((key) => JSON.stringify(key)).join(', ')}.`,
      );
      continue;
    } else if (matches[0] !== expectedKey) {
      errors.push(
        `workspace override ${JSON.stringify(overrideKey)} pins ${expectedVersion}, but pnpm-lock.yaml packages: only has ${JSON.stringify(matches[0])}.`,
      );
    }

    const snapshotSet = snapshotVersions.get(name);
    const inRangeSnapshotVersions =
      snapshotSet === undefined
        ? []
        : [...snapshotSet].filter((version) => range === undefined || versionSatisfiesRange(version, range));

    if (matches.length === 0 && range !== undefined) {
      if (inRangeSnapshotVersions.length > 0) {
        errors.push(
          `workspace override ${JSON.stringify(overrideKey)} pins ${expectedVersion}, but pnpm-lock.yaml packages: has no in-range ${JSON.stringify(name)} pin for ${JSON.stringify(range)} (expected ${JSON.stringify(expectedKey)}).`,
        );
      }
    }

    if (!snapshotSet) continue;

    for (const version of snapshotSet) {
      if (range !== undefined && !versionSatisfiesRange(version, range)) continue;
      if (version !== expectedVersion) {
        errors.push(
          `workspace override ${JSON.stringify(overrideKey)} pins ${expectedVersion}, but snapshots: references ${name}@${version}.`,
        );
      }
    }
  }

  return errors;
}

export function validateRepoLockfile(rootDir) {
  const lockfilePath = join(rootDir, LOCKFILE_NAME);
  const workspacePath = join(rootDir, WORKSPACE_NAME);
  const errors = [];

  const lockfileRead = readTextFile(lockfilePath);
  if (lockfileRead.error) {
    errors.push(lockfileRead.error);
    return errors;
  }

  const workspaceRead = readTextFile(workspacePath);
  if (workspaceRead.error) {
    errors.push(workspaceRead.error);
    return errors;
  }

  errors.push(...validateLockfileText(lockfileRead.text));
  errors.push(...validateWorkspaceOverrides(workspaceRead.text, lockfileRead.text));
  return errors;
}

function splitMappingKey(trimmed) {
  let index = 0;
  let quote = '';
  let key = '';

  if (trimmed[0] === "'" || trimmed[0] === '"') {
    quote = trimmed[0];
    index = 1;
  }

  for (; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote) {
      if (character === '\\') {
        key += trimmed[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = '';
        continue;
      }
      key += character;
      continue;
    }
    if (character === ':') {
      if (key.length === 0) return undefined;
      return { key };
    }
    if (character === ' ' || character === '#' || character === '{' || character === '[') return undefined;
    key += character;
  }

  return undefined;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const errors = validateRepoLockfile(process.cwd());
  if (errors.length > 0) {
    console.error(
      `${LOCKFILE_NAME} is broken and will fail \`pnpm install --frozen-lockfile\` with ERR_PNPM_BROKEN_LOCKFILE, or workspace overrides are out of sync with lockfile package pins.`,
    );
    for (const error of errors) console.error(error);
    console.error(
      'Regenerate it with `pnpm install` and commit one copy of each package and snapshot key. When a lockfile bump changes a bare override target, update the matching entry in pnpm-workspace.yaml overrides too.',
    );
    process.exit(1);
  }
  console.log(
    `${LOCKFILE_NAME} has unique mapping keys, lockfileVersion 9.0, and bare workspace overrides match package pins.`,
  );
}
