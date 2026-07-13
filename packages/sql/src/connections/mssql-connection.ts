import { DatabaseProduct } from '@tslock/sql-support';
import type { ConnectionPool, Request } from 'mssql';
import { translateToNamed } from '../param-translator.js';
import type { QueryResult, SqlConnection } from '../sql-connection.js';

export class MssqlConnection implements SqlConnection {
  constructor(private readonly pool: ConnectionPool) {}

  getDatabaseProduct(): DatabaseProduct {
    return DatabaseProduct.SQL_SERVER;
  }

  async query(sql: string, params: Record<string, unknown>): Promise<QueryResult> {
    const { sql: mssqlSql, params: namedParams } = translateToNamed(sql, params, '@');
    const request: Request = this.pool.request();
    for (const [name, value] of Object.entries(namedParams)) {
      request.input(name, value);
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
