import { LockException } from '@tslock/core';

const NAMED_PARAM_PATTERN = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function translateToPositional(
  sql: string,
  params: Record<string, unknown>,
  placeholder: (index: number) => string,
): { sql: string; values: unknown[] } {
  const seen = new Map<string, number>();
  const values: unknown[] = [];
  let counter = 0;

  const result = sql.replace(NAMED_PARAM_PATTERN, (_match, name: string) => {
    if (!(name in params)) {
      throw new LockException(`Missing param: ${name}`);
    }
    let idx = seen.get(name);
    if (idx === undefined) {
      counter++;
      idx = counter;
      seen.set(name, idx);
      values.push(params[name]);
    }
    return placeholder(idx);
  });

  return { sql: result, values };
}

export function translateToNamed(
  sql: string,
  params: Record<string, unknown>,
  prefix: string,
): { sql: string; params: Record<string, unknown> } {
  const result = sql.replace(NAMED_PARAM_PATTERN, (_match, name: string) => {
    if (!(name in params)) {
      throw new LockException(`Missing param: ${name}`);
    }
    return prefix + name;
  });
  return { sql: result, params };
}
