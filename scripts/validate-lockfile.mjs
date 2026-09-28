import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCKFILE_NAME = 'pnpm-lock.yaml';

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
    errors.push("expected lockfileVersion: '9.0' (packageManager pnpm@11.14.0).");
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
  const lockfilePath = join(process.cwd(), LOCKFILE_NAME);
  const errors = validateLockfileFile(lockfilePath);
  if (errors.length > 0) {
    console.error(
      `${LOCKFILE_NAME} is broken and will fail \`pnpm install --frozen-lockfile\` with ERR_PNPM_BROKEN_LOCKFILE.`,
    );
    for (const error of errors) console.error(error);
    console.error('Regenerate it with `pnpm install` and commit one copy of each package and snapshot key.');
    process.exit(1);
  }
  console.log(`${LOCKFILE_NAME} has unique mapping keys and lockfileVersion 9.0.`);
}
