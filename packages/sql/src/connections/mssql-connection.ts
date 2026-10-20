import { DatabaseProduct } from '@tslock/sql-support';
import { translateToNamed } from '../param-translator.js';
import type { QueryResult, SqlConnection } from '../sql-connection.js';

const DATETIME2_SCALE = 3;

interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  input(name: string, type: unknown, value: unknown): MssqlRequest;
  query(command: string): Promise<{ rowsAffected?: number[] }>;
}

interface MssqlQueryable {
  request(): MssqlRequest;
}

interface MssqlModule {
  DateTime2?: (scale?: number) => unknown;
  default?: MssqlModule;
}

let dateTime2: ((scale?: number) => unknown) | undefined;

export class MssqlConnection implements SqlConnection {
  constructor(private readonly pool: MssqlQueryable) {}

  getDatabaseProduct(): DatabaseProduct {
    return DatabaseProduct.SQL_SERVER;
  }

  async query(sql: string, params: Record<string, unknown>): Promise<QueryResult> {
    const { sql: mssqlSql, params: namedParams } = translateToNamed(sql, params, '@');
    const request = this.pool.request();
    for (const [name, value] of Object.entries(namedParams)) {
      if (value instanceof Date) {
        request.input(name, await datetime2Parameter(), value);
      } else {
        request.input(name, value);
      }
    }
    const result = await request.query(mssqlSql);
    const rowsAffected = result.rowsAffected ?? [0];
    return { affectedRows: rowsAffected[0] ?? 0 };
  }

  isDuplicateKeyError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const e = error as { number?: number };
    return e.number === 2627 || e.number === 2601;
  }
}

async function datetime2Parameter(): Promise<unknown> {
  if (!dateTime2) {
    const loaded = (await import('mssql')) as MssqlModule;
    const factory = loaded.DateTime2 ?? loaded.default?.DateTime2;
    if (typeof factory !== 'function') {
      throw new Error('mssql does not export DateTime2');
    }
    dateTime2 = factory;
  }
  return dateTime2(DATETIME2_SCALE);
}
