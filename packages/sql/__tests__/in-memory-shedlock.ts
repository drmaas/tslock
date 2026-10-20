import { ClockProvider, type LockConfiguration } from '@tslock/core';
import {
  DatabaseProduct,
  DefaultSqlStatementsSource,
  NAMED_PARAM_PATTERN,
  SqlConfiguration,
  type SqlStatementsSource,
} from '@tslock/sql-support';
import { expect } from 'vitest';

export interface ShedlockRow {
  readonly name: string;
  readonly lockUntil: number;
  readonly lockedAt: number;
  readonly lockedBy: string;
}

const COLUMNS = ['name', 'lockUntil', 'lockedAt', 'lockedBy'] as const;
type Column = (typeof COLUMNS)[number];

interface SameHostAccessor {
  insertRecord(config: LockConfiguration): Promise<boolean>;
  updateRecord(config: LockConfiguration): Promise<boolean>;
  unlock(config: LockConfiguration): Promise<void>;
  extend(config: LockConfiguration, previousLockAtMostUntil?: number): Promise<boolean>;
}

function isColumn(value: string): value is Column {
  return (COLUMNS as readonly string[]).includes(value);
}

function literal(value: unknown): string {
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`Unsupported parameter: ${String(value)}`);
}

function bind(sql: string, params: Record<string, unknown> | readonly unknown[]): string {
  if (Array.isArray(params)) return bindPositional(sql, params);
  return sql.replace(new RegExp(NAMED_PARAM_PATTERN.source, 'g'), (_match, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Missing param: ${name}`);
    return literal(params[name]);
  });
}

function bindPositional(sql: string, values: readonly unknown[]): string {
  if (/\$\d+/.test(sql)) {
    return sql.replace(/\$(\d+)/g, (_match, index: string) => {
      const position = Number(index) - 1;
      if (position < 0 || position >= values.length) throw new Error(`Missing positional parameter ${index}`);
      return literal(values[position]);
    });
  }
  let cursor = 0;
  return sql.replace(/\?/g, () => {
    if (cursor >= values.length) throw new Error('Missing positional parameter');
    const value = values[cursor];
    cursor += 1;
    return literal(value);
  });
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseLiteral(raw: string): string | number {
  const text = raw.trim();
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error(`Unsupported literal: ${text}`);
  return Number(text);
}

function parseAssignment(text: string): { column: Column; value: string | number } {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(text.trim());
  if (!match) throw new Error(`Unsupported assignment: ${text}`);
  const column = match[1] ?? '';
  if (!isColumn(column)) throw new Error(`Unknown column ${column}`);
  return { column, value: parseLiteral(match[2] ?? '') };
}

function parsePredicate(text: string): { column: Column; op: string; value: string | number } {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|<>|!=|=|<|>)\s*(.+)$/.exec(text.trim());
  if (!match) throw new Error(`Unsupported predicate: ${text}`);
  const column = match[1] ?? '';
  if (!isColumn(column)) throw new Error(`Unknown column ${column}`);
  return { column, op: match[2] ?? '=', value: parseLiteral(match[3] ?? '') };
}

function rowFrom(columns: string[], values: Array<string | number>): ShedlockRow {
  const record: Partial<Record<Column, string | number>> = {};
  columns.forEach((column, index) => {
    if (!isColumn(column)) throw new Error(`Unknown column ${column}`);
    record[column] = values[index];
  });
  if (
    typeof record.name !== 'string' ||
    typeof record.lockUntil !== 'number' ||
    typeof record.lockedAt !== 'number' ||
    typeof record.lockedBy !== 'string'
  ) {
    throw new Error('INSERT must set name, lockUntil, lockedAt, and lockedBy');
  }
  return {
    name: record.name,
    lockUntil: record.lockUntil,
    lockedAt: record.lockedAt,
    lockedBy: record.lockedBy,
  };
}

function matches(row: ShedlockRow, predicate: { column: Column; op: string; value: string | number }): boolean {
  const actual = row[predicate.column];
  const expected = predicate.value;
  if (typeof actual === 'number' && typeof expected === 'number') {
    switch (predicate.op) {
      case '=':
        return actual === expected;
      case '<=':
        return actual <= expected;
      case '>=':
        return actual >= expected;
      case '<':
        return actual < expected;
      case '>':
        return actual > expected;
      default:
        return false;
    }
  }
  return typeof actual === 'string' && typeof expected === 'string' && predicate.op === '=' && actual === expected;
}

export class InMemoryShedlock {
  private readonly rows = new Map<string, ShedlockRow>();

  get(name: string): ShedlockRow | undefined {
    const row = this.rows.get(name);
    return row ? { ...row } : undefined;
  }

  execute(sql: string, params: Record<string, unknown> | readonly unknown[]): number {
    const bound = bind(sql, params);
    if (/^\s*INSERT\b/i.test(bound)) return this.insert(bound);
    if (/^\s*UPDATE\b/i.test(bound)) return this.update(bound);
    throw new Error(`Unsupported SQL: ${sql}`);
  }

  private insert(sql: string): number {
    const match = /^INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+\S+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(sql);
    if (!match) throw new Error(`Unsupported INSERT: ${sql}`);
    const columns = splitList(match[1] ?? '');
    const values = splitList(match[2] ?? '').map(parseLiteral);
    if (columns.length !== values.length) throw new Error(`Column/value mismatch: ${sql}`);
    const row = rowFrom(columns, values);
    if (this.rows.has(row.name)) return 0;
    this.rows.set(row.name, row);
    return 1;
  }

  private update(sql: string): number {
    const match = /^UPDATE\s+\S+\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i.exec(sql);
    if (!match) throw new Error(`Unsupported UPDATE: ${sql}`);
    const assignments = splitList(match[1] ?? '').map(parseAssignment);
    const predicates = (match[2] ?? '').split(/\s+AND\s+/i).map(parsePredicate);
    let affected = 0;
    for (const row of this.rows.values()) {
      if (!predicates.every((predicate) => matches(row, predicate))) continue;
      let next = row;
      for (const assignment of assignments) {
        next = applyAssignment(next, assignment.column, assignment.value);
      }
      this.rows.set(row.name, next);
      affected += 1;
    }
    return affected;
  }
}

function applyAssignment(row: ShedlockRow, column: Column, value: string | number): ShedlockRow {
  if (column === 'name' || column === 'lockedBy') {
    if (typeof value !== 'string') throw new Error(`Expected string for ${column}`);
    return { ...row, [column]: value };
  }
  if (typeof value !== 'number') throw new Error(`Expected number for ${column}`);
  return { ...row, [column]: value };
}

export async function runSameHostScenario(
  store: InMemoryShedlock,
  open: (source: SqlStatementsSource) => SameHostAccessor,
): Promise<void> {
  try {
    const source = new DefaultSqlStatementsSource(
      new SqlConfiguration({ databaseProduct: DatabaseProduct.MYSQL, lockedByValue: 'host-a' }),
    );
    const holder = open(source);
    const successor = open(source);
    const name = 'job';
    ClockProvider.setClock(() => 0);
    const original: LockConfiguration = { name, lockAtMostFor: 1_000, lockAtLeastFor: 0, createdAt: 0 };
    expect(await holder.insertRecord(original)).toBe(true);
    expect(store.get(name)).toMatchObject({ lockedBy: 'host-a', lockUntil: 1_000 });

    ClockProvider.setClock(() => 5_000);
    expect(await successor.updateRecord({ name, lockAtMostFor: 20_000, lockAtLeastFor: 0, createdAt: 5_000 })).toBe(
      true,
    );
    expect(store.get(name)?.lockUntil).toBe(25_000);
    const acquired = store.get(name);

    await holder.unlock(original);
    expect(store.get(name)).toEqual(acquired);

    const newConfig: LockConfiguration = { name, lockAtMostFor: 60_000, lockAtLeastFor: 0, createdAt: 5_000 };
    expect(await holder.extend(newConfig, 1_000)).toBe(false);
    expect(store.get(name)).toEqual(acquired);
    expect(store.get(name)?.lockUntil).toBe(25_000);
  } finally {
    ClockProvider.resetClock();
  }
}
