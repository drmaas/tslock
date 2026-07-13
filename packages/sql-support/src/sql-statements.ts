export interface SqlStatements {
  readonly insert: string;
  readonly update: string;
  readonly extend: string;
  readonly unlock: string;
}

export const SQL_PARAM_NAMES = {
  NAME: 'name',
  LOCK_UNTIL: 'lockUntil',
  NOW: 'now',
  LOCKED_BY: 'lockedBy',
  UNLOCK_TIME: 'unlockTime',
} as const;

export const NAMED_PARAM_PATTERN = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function translateToPositional(sql: string, _paramOrder: readonly string[]): string {
  let index = 0;
  return sql.replace(NAMED_PARAM_PATTERN, () => {
    return `$${++index}`;
  });
}

export function buildPositionalParams(params: Record<string, unknown>, paramOrder: readonly string[]): unknown[] {
  return paramOrder.map((name) => params[name]);
}

export function translateNamedParams(
  sql: string,
  params: Record<string, unknown>,
  placeholder: (index: number) => string,
): { sql: string; values: unknown[] } {
  const seen = new Map<string, number>();
  const values: unknown[] = [];
  let counter = 0;

  const result = sql.replace(NAMED_PARAM_PATTERN, (_match, name: string) => {
    if (!(name in params)) {
      throw new Error(`Missing param: ${name}`);
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
