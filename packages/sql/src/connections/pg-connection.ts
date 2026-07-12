import { DatabaseProduct } from '@tslock/sql-support';
import type { Pool } from 'pg';
import type { QueryResult, SqlConnection } from '../sql-connection.js';
import { translateToPositional } from '../param-translator.js';

export class PgConnection implements SqlConnection {
  constructor(private readonly pool: Pool) {}

  getDatabaseProduct(): DatabaseProduct {
    return DatabaseProduct.POSTGRES;
  }

  async query(sql: string, params: Record<string, unknown>): Promise<QueryResult> {
    const { sql: pgSql, values } = translateToPositional(sql, params, (i) => `$${i}`);
    const result = await this.pool.query(pgSql, values);
    return { affectedRows: result.rowCount ?? 0 };
  }

  isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === '23505'
    );
  }
}
